/**
 * Ядро бота: одно на оба мессенджера. Адаптеры зовут onText / onFiles /
 * onCallback, ядро отвечает через Messenger нужной платформы.
 *
 * Путь человека: прислал 1–10 фото → получил те же файлы с вотермаркой по
 * своим настройкам, под ними кнопки «📍 Место · 📏 Размер · …». Поменял —
 * эта же пачка переделывается, старые файлы заменяются, выбор запоминается.
 */
import { ImageError, prepareWatermark, renderWatermarked } from "../image/watermark.js";
import type { Logger } from "../logger.js";
import type { Store, UserRow, WatermarkInfo } from "../db/store.js";
import type { Batch, BatchStore } from "./batches.js";
import { FileCollector, MAX_BATCH, SerialQueue, chunk, type Collected } from "./collector.js";
import {
  accessScreen,
  addWatermarkScreen,
  deleteConfirmScreen,
  esc,
  libraryScreen,
  pickerScreen,
  resultScreen,
  settingsScreen,
  startScreen,
  type PickerKind,
  type Screen,
} from "./screens.js";
import { OPACITIES, POSITION_LABEL, SIZES, isPosition, opacityLabel, sizeLabel, type WatermarkSettings } from "./settings.js";
import {
  DownloadError,
  PLATFORM_LABEL,
  parseUserKey,
  userKeyString,
  type IncomingFile,
  type Messenger,
  type OutFile,
  type Person,
  type Platform,
  type UserKey,
} from "./types.js";

/** Повторный запрос доступа админам — не чаще раза в сутки. */
const REQUEST_COOLDOWN_MS = 24 * 3600_000;
/** Сколько ждать вотермарку после «➕ Добавить». */
const ADD_WAIT_MS = 15 * 60_000;
const NAME_MAX = 40;

export interface AppDeps {
  store: Store;
  batches: BatchStore;
  log: Logger;
  admins: UserKey[];
  /** Доступ из .env — его нельзя закрыть кнопкой. */
  envAllowed: UserKey[];
}

const sameKey = (a: UserKey, b: UserKey): boolean => a.platform === b.platform && a.id === b.id;

export class App {
  private readonly messengers = new Map<Platform, Messenger>();
  private readonly collector: FileCollector;
  private readonly cpu = new SerialQueue();
  /** Очередь каждого человека: его пачки — по порядку. */
  private readonly perUser = new Map<string, SerialQueue>();
  /** Админ нажал «➕ Добавить» — следующие файлы идут в базу вотермарок. */
  private readonly adding = new Map<string, number>();

  constructor(private readonly d: AppDeps) {
    this.collector = new FileCollector((c) => {
      const key = userKeyString(c.person);
      let q = this.perUser.get(key);
      if (!q) this.perUser.set(key, (q = new SerialQueue()));
      void q.run(() => this.handleCollected(c)).catch((err: unknown) => this.d.log.error({ err, user: key }, "batch failed"));
    });
  }

  register(m: Messenger): void {
    this.messengers.set(m.platform, m);
  }

  private m(p: Platform): Messenger {
    const m = this.messengers.get(p);
    if (!m) throw new Error(`messenger ${p} is not registered`);
    return m;
  }

  // ── доступ ──

  isAdmin(k: UserKey): boolean {
    return this.d.admins.some((a) => sameKey(a, k));
  }

  private allowed(u: UserRow): boolean {
    const k = { platform: u.platform, id: u.extId };
    return this.isAdmin(k) || this.d.envAllowed.some((a) => sameKey(a, k)) || u.access === "allowed";
  }

  /** true — можно работать; иначе человеку уже ответили (и при надобности спросили админов). */
  private async gate(p: Person, u: UserRow): Promise<boolean> {
    if (this.allowed(u)) return true;
    const m = this.m(p.platform);
    const recent = u.requestedAt != null && Date.now() - Date.parse(u.requestedAt) < REQUEST_COOLDOWN_MS;
    if (u.access === "denied" && recent) {
      await m.sendText(p.id, "🔒 Доступа к боту нет. Если это ошибка — напиши админу медиа.");
      return false;
    }
    if (u.access === "pending" && recent) {
      await m.sendText(p.id, "⏳ Запрос на доступ уже у админов — напишу, как только пустят.");
      return false;
    }
    if (!this.d.admins.length) {
      await m.sendText(p.id, `🔒 Бот только для медиакоманды, а админы ещё не настроены.\nТвой id в ${PLATFORM_LABEL[p.platform]}: <code>${p.id}</code>`);
      return false;
    }
    this.d.store.markRequested(p);
    this.d.store.bump("access:request");
    const who = this.personLabel(u);
    const key = userKeyString(p);
    let delivered = 0;
    for (const a of this.d.admins) {
      const am = this.messengers.get(a.platform);
      if (!am) continue;
      try {
        await am.sendText(a.id, `🔑 Просит доступ: <b>${esc(who)}</b>\n${PLATFORM_LABEL[p.platform]}, id <code>${p.id}</code>`, [
          [
            { text: "✅ Пустить", data: `ga:${key}` },
            { text: "🚫 Нет", data: `gd:${key}` },
          ],
        ]);
        delivered++;
      } catch (err) {
        // Админ ещё не писал боту в этом мессенджере — написать ему первым бот не может.
        this.d.log.warn({ err, admin: userKeyString(a) }, "access request not delivered");
      }
    }
    await m.sendText(
      p.id,
      delivered
        ? `🔒 Бот работает только для медиакоманды. Отправил админам запрос — напишу, как только пустят.\nТвой id в ${PLATFORM_LABEL[p.platform]}: <code>${p.id}</code>`
        : `🔒 Бот работает только для медиакоманды. Админам запрос не дошёл — перешли им свой id в ${PLATFORM_LABEL[p.platform]}: <code>${p.id}</code>`,
    );
    return false;
  }

  private personLabel(u: UserRow): string {
    const name = u.firstName?.trim() || "без имени";
    return `${name}${u.username ? ` @${u.username}` : ""} (${PLATFORM_LABEL[u.platform]})`;
  }

  // ── вотермарка человека ──

  private library(): WatermarkInfo[] {
    return this.d.store.watermarks();
  }

  /** Выбранная вотермарка, а если не выбрана или удалена — первая в базе. */
  private watermarkFor(u: UserRow): WatermarkInfo | null {
    return (u.watermarkId != null ? this.d.store.watermark(u.watermarkId) : null) ?? this.library()[0] ?? null;
  }

  private settingsOf(u: UserRow): WatermarkSettings & { watermarkId: number | null } {
    return { ...u.settings, watermarkId: this.watermarkFor(u)?.id ?? null };
  }

  // ── текст и команды ──

  async onText(p: Person, text: string): Promise<void> {
    const u = this.d.store.touchUser(p, p.firstName, p.username);
    const m = this.m(p.platform);
    const cmd = /^\/([a-z_]+)/i.exec(text.trim())?.[1]?.toLowerCase();
    if (cmd === "id") {
      await m.sendText(p.id, `Твой id в ${PLATFORM_LABEL[p.platform]}: <code>${p.id}</code>`);
      return;
    }
    if (!(await this.gate(p, u))) return;
    if (cmd === "settings" || /^⚙️?\s*настройки$/i.test(text.trim())) {
      await this.send(p, this.settings(u));
      return;
    }
    if (cmd === "stats" && this.isAdmin(p)) {
      await m.sendText(p.id, this.statsText());
      return;
    }
    if (cmd === "cancel" && this.adding.delete(userKeyString(p))) {
      await m.sendText(p.id, "Отменил добавление вотермарки.");
      return;
    }
    // /start, /help и любой другой текст — подсказка, что делать.
    const wm = this.watermarkFor(u);
    await this.send(p, startScreen(wm, u.settings, !wm));
  }

  private settings(u: UserRow): Screen {
    const lib = this.library();
    return settingsScreen(this.watermarkFor(u), u.settings, { admin: this.isAdmin({ platform: u.platform, id: u.extId }), libraryEmpty: !lib.length });
  }

  private async send(p: UserKey, s: Screen): Promise<string> {
    return this.m(p.platform).sendText(p.id, s.text, s.keyboard);
  }

  /** Экран — на месте сообщения с кнопкой, а если его нет — новым. */
  private async show(p: UserKey, messageId: string | null, s: Screen): Promise<void> {
    const m = this.m(p.platform);
    if (messageId) {
      try {
        await m.editText(p.id, messageId, s.text, s.keyboard);
        return;
      } catch (err) {
        this.d.log.debug({ err }, "edit failed, sending new");
      }
    }
    await m.sendText(p.id, s.text, s.keyboard);
  }

  // ── файлы ──

  /** Файлы из одного события мессенджера; альбом собирается коллектором. */
  onFiles(p: Person, files: IncomingFile[], caption: string | null): void {
    if (files.length) this.collector.add(p, files, caption);
  }

  private async handleCollected(c: Collected): Promise<void> {
    const p = c.person;
    const u = this.d.store.touchUser(p, p.firstName, p.username);
    if (!(await this.gate(p, u))) return;
    const addingSince = this.adding.get(userKeyString(p));
    if (addingSince != null && Date.now() - addingSince < ADD_WAIT_MS && this.isAdmin(p)) {
      this.adding.delete(userKeyString(p));
      await this.addWatermarks(p, c.files, c.caption);
      return;
    }
    for (const part of chunk(c.files, MAX_BATCH)) await this.processNew(p, part);
  }

  private async download(files: IncomingFile[]): Promise<{ ok: Array<{ name: string; bytes: Buffer; compressed: boolean }>; errors: string[] }> {
    const ok: Array<{ name: string; bytes: Buffer; compressed: boolean }> = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        ok.push({ name: f.name, bytes: await f.fetch(), compressed: f.compressed });
      } catch (err) {
        if (!(err instanceof DownloadError)) this.d.log.warn({ err }, "download failed");
        errors.push(`${esc(f.name)} — ${err instanceof DownloadError ? err.message : "не скачался, пришли ещё раз"}`);
      }
    }
    return { ok, errors };
  }

  private async processNew(p: Person, files: IncomingFile[]): Promise<void> {
    const m = this.m(p.platform);
    const u = this.d.store.user(p)!;
    const wm = this.watermarkFor(u);
    if (!wm) {
      const admin = this.isAdmin(p);
      await m.sendText(
        p.id,
        admin ? "В базе пока нет вотермарок. Добавь первую — и сразу пришли фото снова." : "В базе пока нет вотермарок — их добавляет админ. Напиши ему.",
        admin ? [[{ text: "➕ Добавить вотермарку", data: "la" }]] : undefined,
      );
      return;
    }
    const status = await m.sendText(p.id, `⏳ Ставлю вотермарку на ${files.length} фото…`);
    const { ok, errors } = await this.download(files);
    if (!ok.length) {
      await m.editText(p.id, status, `❌ Не вышло:\n${errors.map((e) => `• ${e}`).join("\n")}`);
      return;
    }
    const batch = this.d.batches.create(p, ok, errors);
    this.d.store.bump("batches");
    this.d.store.bump("photos", ok.length);
    const compressed = ok.filter((f) => f.compressed).length;
    if (compressed) this.d.store.bump("photos:compressed", compressed);
    await this.deliver(p, batch, u, status);
  }

  /** Отрисовать пачку по текущим настройкам, прислать файлы и кнопки; старый результат убрать. */
  private async deliver(p: UserKey, batch: Batch, u: UserRow, statusId: string): Promise<void> {
    const m = this.m(p.platform);
    const wm = this.watermarkFor(u)!;
    const wmPng = this.d.store.watermarkPng(wm.id)!;
    const out: OutFile[] = [];
    const errors = [...batch.downloadErrors];
    for (const f of batch.files) {
      try {
        const r = await this.cpu.run(() => renderWatermarked(this.d.batches.read(f), f.name, wmPng, u.settings));
        if (r.bytes.length > m.maxUploadBytes) {
          errors.push(`${esc(f.name)} — с вотермаркой больше ${Math.floor(m.maxUploadBytes / 1048576)} МБ, ${PLATFORM_LABEL[p.platform]} не даёт боту отправить такой файл`);
          continue;
        }
        out.push({ name: r.name, bytes: r.bytes, mime: r.mime });
      } catch (err) {
        if (!(err instanceof ImageError)) this.d.log.error({ err }, "render failed");
        errors.push(`${esc(f.name)} — ${err instanceof ImageError ? esc(err.message) : "не удалось обработать"}`);
      }
    }
    if (errors.length > batch.downloadErrors.length) this.d.store.bump("errors", errors.length - batch.downloadErrors.length);
    // При переделке старый результат ещё в чате — кнопка возвращает его кнопки.
    const retry = batch.outIds.length ? [[{ text: "◀️ Назад", data: `bk:${batch.id}` }]] : undefined;
    if (!out.length) {
      await m.editText(p.id, statusId, `❌ Не вышло:\n${errors.map((e) => `• ${e}`).join("\n")}`, retry);
      return;
    }
    let ids: string[];
    try {
      ids = await m.sendFiles(p.id, out);
    } catch (err) {
      this.d.log.error({ err }, "send files failed");
      await m.editText(p.id, statusId, "❌ Не получилось отправить файлы. Попробуй ещё раз через минуту.", retry);
      return;
    }
    // Новое уже в чате — теперь убираем старое: прошлый результат, его кнопки и «⏳».
    const old = [...batch.outIds, ...(batch.controlId ? [batch.controlId] : []), statusId].filter((id, i, a) => a.indexOf(id) === i);
    await m.deleteMessages(p.id, old);
    batch.outIds = ids;
    batch.done = out.length;
    const screen = resultScreen(batch.id, out.length, wm, u.settings, {
      errors,
      compressed: batch.files.filter((f) => f.compressed).length,
      platform: p.platform,
      watermarks: this.library().length,
    });
    batch.controlId = await m.sendText(p.id, screen.text, screen.keyboard);
  }

  // ── вотермарки в базе (админ) ──

  private async addWatermarks(p: Person, files: IncomingFile[], caption: string | null): Promise<void> {
    const m = this.m(p.platform);
    const lines: string[] = [];
    const { ok, errors } = await this.download(files);
    for (const [i, f] of ok.entries()) {
      if (f.compressed) {
        lines.push(`❌ ${esc(f.name)} — пришло сжатым фото, прозрачность потерялась. Пришли файлом: 📎 → Файл.`);
        continue;
      }
      try {
        const w = await this.cpu.run(() => prepareWatermark(f.bytes));
        const base = (i === 0 && caption?.trim()) || f.name.replace(/\.[^.]+$/, "") || "Вотермарка";
        const name = base.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
        this.d.store.addWatermark(name, w.png, w.width, w.height, p);
        lines.push(`✅ «${esc(name)}» — ${w.width}×${w.height}`);
        if (!w.hasAlpha) lines.push("   ⚠️ без прозрачного фона — на фото встанет прямоугольником. Лучше PNG с прозрачностью.");
      } catch (err) {
        if (!(err instanceof ImageError)) this.d.log.error({ err }, "watermark prepare failed");
        lines.push(`❌ ${esc(f.name)} — ${err instanceof ImageError ? esc(err.message) : "не удалось обработать"}`);
      }
    }
    for (const e of errors) lines.push(`❌ ${e}`);
    await m.sendText(p.id, `🗂 <b>Добавление в базу</b>\n${lines.join("\n")}`, [
      [
        { text: "🗂 Вотермарки в базе", data: "lib" },
        { text: "⚙️ Настройки", data: "st" },
      ],
    ]);
  }

  // ── кнопки ──

  /** Возвращает текст всплывающего уведомления (или ничего). */
  async onCallback(p: Person, data: string, messageId: string | null): Promise<string | undefined> {
    const u = this.d.store.touchUser(p, p.firstName, p.username);
    const admin = this.isAdmin(p);
    const [action, ...args] = data.split(":");

    // Решение админа по запросу доступа.
    if ((action === "ga" || action === "gd") && admin) return this.decideAccess(p, args.join(":"), action === "ga", messageId);

    if (!(await this.gate(p, u))) return undefined;
    switch (action) {
      case "st":
        this.adding.delete(userKeyString(p));
        await this.show(p, messageId, this.settings(u));
        return undefined;
      case "pk": {
        const [kind, ctx] = args;
        if (!kind || !ctx || !"wpzo".includes(kind)) return undefined;
        this.d.store.bump(`open:${kind}:${ctx === "s" ? "settings" : "result"}`);
        await this.show(p, messageId, pickerScreen(kind as PickerKind, ctx, this.settingsOf(u), this.library()));
        return undefined;
      }
      case "bk":
        return this.back(p, u, args[0] ?? "s", messageId);
      case "sv":
        return this.setValue(p, u, args[0] ?? "", args[1] ?? "", args[2] ?? "s", messageId);
    }

    if (!admin) return undefined;
    switch (action) {
      case "lib":
        this.adding.delete(userKeyString(p));
        await this.show(p, messageId, libraryScreen(this.library()));
        return undefined;
      case "la":
        this.adding.set(userKeyString(p), Date.now());
        await this.show(p, messageId, addWatermarkScreen());
        return undefined;
      case "lx":
        this.adding.delete(userKeyString(p));
        await this.show(p, messageId, libraryScreen(this.library()));
        return "Отменил";
      case "ld": {
        const wm = this.d.store.watermark(Number(args[0]));
        if (!wm) return "Её уже нет в базе";
        await this.show(p, messageId, deleteConfirmScreen(wm, this.d.store.watermarkUsers(wm.id)));
        return undefined;
      }
      case "ldy": {
        const wm = this.d.store.watermark(Number(args[0]));
        if (wm) this.d.store.deleteWatermark(wm.id);
        await this.show(p, messageId, libraryScreen(this.library()));
        return wm ? `Удалил «${wm.name}»` : "Её уже нет в базе";
      }
      case "acc":
        await this.show(p, messageId, this.accessScreen());
        return undefined;
      case "ar": {
        const k = parseUserKey(args.join(":"));
        if (k) this.d.store.setAccess(k, "none");
        await this.show(p, messageId, this.accessScreen());
        return "Доступ закрыт";
      }
    }
    return undefined;
  }

  private accessScreen(): Screen {
    const granted = this.d.store.allowedUsers().map((r) => ({ key: userKeyString({ platform: r.platform, id: r.extId }), label: this.personLabel(r) }));
    const env = { tg: 0, max: 0 };
    for (const k of this.d.envAllowed) env[k.platform]++;
    return accessScreen(env, granted);
  }

  private async decideAccess(adminKey: Person, target: string, allow: boolean, messageId: string | null): Promise<string | undefined> {
    const k = parseUserKey(target);
    const t = k ? this.d.store.user(k) : null;
    if (!k || !t) return "Не нашёл этого человека";
    this.d.store.setAccess(k, allow ? "allowed" : "denied");
    this.d.store.bump(allow ? "access:granted" : "access:denied");
    const label = esc(this.personLabel(t));
    await this.show(
      adminKey,
      messageId,
      allow
        ? { text: `✅ Пустил: <b>${label}</b>` }
        : { text: `🚫 Не пустил: <b>${label}</b>`, keyboard: [[{ text: "↩️ Всё же пустить", data: `ga:${target}` }]] },
    );
    const tm = this.messengers.get(k.platform);
    if (tm) {
      const u = this.d.store.user(k)!;
      const wm = this.watermarkFor(u);
      const text = allow ? `✅ Доступ открыт!\n\n${startScreen(wm, u.settings, !wm).text}` : "🔒 Админ не открыл доступ к боту.";
      await tm.sendText(k.id, text, allow ? [[{ text: "⚙️ Настройки", data: "st" }]] : undefined).catch((err: unknown) => this.d.log.warn({ err }, "access notice not delivered"));
    }
    return allow ? "Пустил" : "Не пустил";
  }

  private async back(p: Person, u: UserRow, ctx: string, messageId: string | null): Promise<string | undefined> {
    if (ctx === "s") {
      await this.show(p, messageId, this.settings(u));
      return undefined;
    }
    const batch = this.d.batches.get(ctx, p);
    const wm = this.watermarkFor(u);
    if (!batch) {
      await this.show(p, messageId, { text: `Сейчас ставлю: ${wm ? `«${esc(wm.name)}»` : "—"}, ${POSITION_LABEL[u.settings.position]}, ${sizeLabel(u.settings.size)}.`, keyboard: [[{ text: "⚙️ Настройки", data: "st" }]] });
      return undefined;
    }
    const s = resultScreen(batch.id, batch.done, wm, u.settings, {
      errors: batch.downloadErrors,
      compressed: batch.files.filter((f) => f.compressed).length,
      platform: p.platform,
      watermarks: this.library().length,
    });
    await this.show(p, messageId, s);
    return undefined;
  }

  /** Новое значение настройки; под готовыми файлами — сразу переделать пачку. */
  private async setValue(p: Person, u: UserRow, kind: string, raw: string, ctx: string, messageId: string | null): Promise<string | undefined> {
    const before = this.settingsOf(u);
    let toast: string;
    if (kind === "p" && isPosition(raw)) {
      this.d.store.setSettings(p, { position: raw });
      toast = `Место: ${POSITION_LABEL[raw]}`;
    } else if (kind === "z" && (SIZES as readonly number[]).includes(Number(raw))) {
      this.d.store.setSettings(p, { size: Number(raw) });
      toast = `Размер: ${sizeLabel(Number(raw))}`;
    } else if (kind === "o" && (OPACITIES as readonly number[]).includes(Number(raw))) {
      this.d.store.setSettings(p, { opacity: Number(raw) });
      toast = `Прозрачность: ${opacityLabel(Number(raw))}`;
    } else if (kind === "w" && this.d.store.watermark(Number(raw))) {
      this.d.store.setSettings(p, { watermarkId: Number(raw) });
      toast = `Вотермарка: «${this.d.store.watermark(Number(raw))!.name}»`;
    } else {
      return "Такого варианта уже нет";
    }
    const fresh = this.d.store.user(p)!;
    const after = this.settingsOf(fresh);
    const changed = before.position !== after.position || before.size !== after.size || before.opacity !== after.opacity || before.watermarkId !== after.watermarkId;
    this.d.store.bump(`set:${kind}:${ctx === "s" ? "settings" : "result"}`);

    if (ctx === "s") {
      await this.show(p, messageId, this.settings(fresh));
      return toast;
    }
    const batch = this.d.batches.get(ctx, p);
    if (!batch) {
      await this.show(p, messageId, { text: `Запомнил. Эти фото я уже не храню — пришли их снова, поставлю так.\nСейчас: ${POSITION_LABEL[after.position]}, ${sizeLabel(after.size)}.`, keyboard: [[{ text: "⚙️ Настройки", data: "st" }]] });
      return toast;
    }
    if (!changed) return this.back(p, fresh, ctx, messageId).then(() => toast);
    if (batch.busy) return "Ещё переделываю прошлое — секунду";
    batch.busy = true;
    // Кнопки прячем, пока идёт работа: второе нажатие не запустит вторую переделку.
    const status = messageId ?? (await this.m(p.platform).sendText(p.id, "⏳"));
    await this.show(p, status, { text: `⏳ Переделываю ${batch.files.length} фото…` });
    batch.controlId = status;
    void this.redo(p, batch, status);
    return toast;
  }

  private async redo(p: Person, batch: Batch, statusId: string): Promise<void> {
    const key = userKeyString(p);
    let q = this.perUser.get(key);
    if (!q) this.perUser.set(key, (q = new SerialQueue()));
    try {
      await q.run(async () => {
        const u = this.d.store.user(p)!;
        if (!this.watermarkFor(u)) {
          await this.m(p.platform).editText(p.id, statusId, "В базе не осталось вотермарок.");
          return;
        }
        this.d.store.bump("redo");
        await this.deliver(p, batch, u, statusId);
      });
    } catch (err) {
      this.d.log.error({ err }, "redo failed");
    } finally {
      batch.busy = false;
    }
  }

  // ── /stats ──

  statsText(): string {
    const s = this.d.store.stats(7);
    const c = this.d.store.userCounts();
    const g = (k: string): number => s.get(k) ?? 0;
    const lines = [
      "📊 <b>За 7 дней</b>",
      `Фото: ${g("photos")} (сжатых мессенджером: ${g("photos:compressed")}), пачек: ${g("batches")}, переделок: ${g("redo")}, ошибок: ${g("errors")}`,
      "",
      "Кнопки под результатом (открыли → выбрали):",
      `📍 Место ${g("open:p:result")} → ${g("set:p:result")} · 📏 Размер ${g("open:z:result")} → ${g("set:z:result")}`,
      `🌫 Прозрачность ${g("open:o:result")} → ${g("set:o:result")} · 🖼 Вотермарка ${g("open:w:result")} → ${g("set:w:result")}`,
      "В ⚙️ Настройках:",
      `📍 ${g("set:p:settings")} · 📏 ${g("set:z:settings")} · 🌫 ${g("set:o:settings")} · 🖼 ${g("set:w:settings")}`,
      "",
      `Люди: всего ${c.total}, с доступом из бота ${c.allowed}, ждут ${c.pending}; запросов за 7 дней ${g("access:request")}`,
    ];
    return lines.join("\n");
  }
}
