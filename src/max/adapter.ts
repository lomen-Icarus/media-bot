/**
 * МАКС: события long polling → App, ответы App → Bot API МАКС. Только личные
 * диалоги. Результат уходит вложениями-файлами (type "file"), а не картинками:
 * картинку мессенджер может пересжать, файл — нет.
 */
import type { App } from "../core/app.js";
import { DownloadError, type IncomingFile, type Keyboard, type Messenger, type OutFile, type Person } from "../core/types.js";
import { IMAGE_EXTENSIONS } from "../image/watermark.js";
import type { Logger } from "../logger.js";
import type { Store } from "../db/store.js";
import { MaxApi, MaxApiError, type MaxAttachment, type MaxMessage, type MaxUpdate, type MaxUser } from "./api.js";

const MARKER_KEY = "max:marker";
const UPDATE_TYPES = ["message_created", "message_callback", "bot_started"];
/** Больше не скачиваем: память маленького сервера. */
export const MAX_DOWNLOAD_LIMIT = 100 * 1024 * 1024;

const COMMANDS = [
  { name: "start", description: "Как пользоваться" },
  { name: "settings", description: "Вотермарка, место, размер" },
  { name: "id", description: "Мой id (для доступа)" },
];

function keyboardAttachment(kb: Keyboard | undefined): MaxAttachment[] {
  if (!kb?.length) return [];
  return [{ type: "inline_keyboard", payload: { buttons: kb.map((row) => row.map((b) => ({ type: "callback" as const, text: b.text, payload: b.data }))) } }];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MaxMessenger implements Messenger {
  readonly platform = "max" as const;
  /** Лимит МАКС на файл от бота документацией из песочницы не проверен; отправку большего файла отвергнет сам МАКС. */
  readonly maxUploadBytes = Number.MAX_SAFE_INTEGER;
  private stopped = false;
  /** МАКС не принял несколько файлов одним сообщением — дальше шлём по одному. */
  private onePerMessage = false;

  constructor(
    readonly api: MaxApi,
    private readonly app: App,
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  // ── Messenger ──

  async sendText(chatId: number, text: string, keyboard?: Keyboard): Promise<string> {
    const m = await this.api.sendMessage(chatId, { text, format: "html", attachments: keyboardAttachment(keyboard) }, { disableLinkPreview: true });
    return m.body.mid;
  }

  async editText(_chatId: number, messageId: string, text: string, keyboard?: Keyboard): Promise<void> {
    await this.api.editMessage(messageId, { text, format: "html", attachments: keyboardAttachment(keyboard) });
  }

  async sendFiles(chatId: number, files: OutFile[]): Promise<string[]> {
    const atts: MaxAttachment[] = [];
    for (const f of files) atts.push(await this.api.upload("file", f.bytes, f.name));
    if (atts.length > 1 && !this.onePerMessage) {
      try {
        const m = await this.api.sendMessage(chatId, { text: null, attachments: atts });
        return [m.body.mid];
      } catch (err) {
        if (!(err instanceof MaxApiError) || err.status >= 500) throw err;
        this.log.warn({ err: `${err.status} ${err.code}` }, "MAX rejected several files in one message, sending one by one");
        this.onePerMessage = true;
      }
    }
    const ids: string[] = [];
    for (const a of atts) ids.push((await this.api.sendMessage(chatId, { text: null, attachments: [a] })).body.mid);
    return ids;
  }

  async deleteMessages(_chatId: number, messageIds: string[]): Promise<void> {
    for (const mid of messageIds) await this.api.deleteMessage(mid).catch((err: unknown) => this.log.debug({ err: String(err).slice(0, 120) }, "MAX delete failed"));
  }

  // ── входящие ──

  private person(u: MaxUser): Person {
    return { platform: "max", id: u.user_id, firstName: (u.first_name || u.name || "").trim() || null, username: u.username ?? null };
  }

  private incoming(msg: MaxMessage): { files: IncomingFile[]; rejected: string[] } {
    const files: IncomingFile[] = [];
    const rejected: string[] = [];
    (msg.body.attachments ?? []).forEach((a, i) => {
      const url = a.payload?.url;
      if (a.type === "image" && url) {
        files.push(this.file(url, `photo_${msg.timestamp}_${i + 1}.jpg`, null));
      } else if (a.type === "file" && url) {
        const name = a.filename || `file_${i + 1}`;
        if (IMAGE_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? "")) files.push(this.file(url, name, a.size ?? null));
        else rejected.push(name);
      }
    });
    return { files, rejected };
  }

  private file(url: string, name: string, size: number | null): IncomingFile {
    return {
      name,
      size,
      // Пересжимает ли МАКС картинки, отправленные «как фото», — не проверено; помечаем только Telegram.
      compressed: false,
      fetch: async () => {
        if (size != null && size > MAX_DOWNLOAD_LIMIT) throw new DownloadError("больше 100 МБ — такие бот не берёт");
        try {
          return await this.api.download(url, MAX_DOWNLOAD_LIMIT);
        } catch (err) {
          if (err instanceof MaxApiError && err.code === "too.big") throw new DownloadError("больше 100 МБ — такие бот не берёт");
          throw err;
        }
      },
    };
  }

  private async dispatch(u: MaxUpdate): Promise<void> {
    if (u.update_type === "message_created") {
      const msg = (u as Extract<MaxUpdate, { update_type: "message_created" }>).message;
      if (msg.recipient.chat_type !== "dialog" || !msg.sender || msg.sender.is_bot) return;
      const p = this.person(msg.sender);
      const { files, rejected } = this.incoming(msg);
      const text = msg.body.text ?? "";
      if (files.length) this.app.onFiles(p, files, text || null);
      if (rejected.length) await this.sendText(p.id, `Это не картинка: ${rejected.join(", ")}. Пришли JPG, PNG, WebP или TIFF.`);
      if (!files.length && !rejected.length && text) await this.app.onText(p, text);
      return;
    }
    if (u.update_type === "message_callback") {
      const ev = u as Extract<MaxUpdate, { update_type: "message_callback" }>;
      const toast = await this.app.onCallback(this.person(ev.callback.user), ev.callback.payload ?? "", ev.message?.body.mid ?? null);
      if (toast) await this.api.answerCallback(ev.callback.callback_id, toast).catch(() => undefined);
      return;
    }
    if (u.update_type === "bot_started") {
      const ev = u as Extract<MaxUpdate, { update_type: "bot_started" }>;
      await this.app.onText(this.person(ev.user), "/start");
    }
  }

  /** Ждёт МАКС, пока тот не ответит (сбой сети при старте не выключает бота в МАКС навсегда); 401 — сразу ошибка. */
  async start(): Promise<void> {
    let delay = 5000;
    let me;
    for (;;) {
      try {
        me = await this.api.me();
        break;
      } catch (err) {
        if (this.stopped || (err instanceof MaxApiError && err.status === 401)) throw err;
        this.log.warn({ err: String(err).slice(0, 200), delay }, "MAX not reachable, retrying");
        await sleep(delay);
        delay = Math.min(delay * 2, 300_000);
      }
    }
    this.log.info({ id: me.user_id, username: me.username }, "MAX bot authorised");
    await this.api.setCommands(COMMANDS).catch((err: unknown) => this.log.warn({ err: String(err).slice(0, 120) }, "MAX commands not set"));
    void this.poll();
  }

  private async poll(): Promise<void> {
    const saved = this.store.getMeta(MARKER_KEY);
    let marker: number | null = saved ? Number(saved) : null;
    let delay = 1000;
    this.log.info({ resume: marker != null }, "polling MAX");
    while (!this.stopped) {
      try {
        const res = await this.api.updates({ marker, types: UPDATE_TYPES });
        delay = 1000;
        for (const u of res.updates ?? []) {
          await this.dispatch(u).catch((err: unknown) => this.log.error({ err, type: u.update_type }, "MAX update failed"));
        }
        if (res.marker != null && res.marker !== marker) {
          marker = res.marker;
          this.store.setMeta(MARKER_KEY, String(marker));
        }
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof MaxApiError && err.status === 401) {
          this.log.error("MAX_BOT_TOKEN не подходит (401): МАКС остановлен, Telegram работает");
          return;
        }
        this.log.warn({ err: String(err).slice(0, 200), delay }, "MAX polling error");
        await sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
