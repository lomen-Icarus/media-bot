/**
 * Telegram: события grammY → App, ответы App → Bot API. Только личные чаты.
 *
 * Качество: фото, отправленное «как фото», Telegram сжимает ещё на телефоне
 * (боту доступна только сжатая копия), поэтому без потерь — только «файлом».
 * Результат уходит документами: их Telegram не пересжимает.
 */
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, InputFile, type Context } from "grammy";
import type { InlineKeyboardMarkup, InputMediaDocument, Message } from "grammy/types";
import type { App } from "../core/app.js";
import { DownloadError, type IncomingFile, type Keyboard, type Messenger, type OutFile, type Person } from "../core/types.js";
import { IMAGE_EXTENSIONS } from "../image/watermark.js";
import type { Logger } from "../logger.js";

/** Bot API отдаёт боту файлы до 20 МБ, принимает от бота — до 50 МБ. */
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TG_UPLOAD_LIMIT = 50 * 1024 * 1024;
/** Альбом — до 10 файлов; общий размер одного запроса держим не больше лимита на файл. */
const ALBUM_MAX = 10;

const COMMANDS = [
  { command: "start", description: "Как пользоваться" },
  { command: "settings", description: "Вотермарка, место, размер" },
  { command: "id", description: "Мой id (для доступа)" },
];

function markup(kb: Keyboard | undefined): InlineKeyboardMarkup {
  return { inline_keyboard: (kb ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

/** Альбомы документов: не больше 10 файлов и не больше лимита по суммарному размеру. */
export function albums(files: OutFile[], maxBytes = TG_UPLOAD_LIMIT): OutFile[][] {
  const out: OutFile[][] = [];
  let cur: OutFile[] = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= ALBUM_MAX || size + f.bytes.length > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += f.bytes.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const isImageDocument = (mime: string | undefined, name: string | undefined): boolean =>
  Boolean(mime?.startsWith("image/")) || IMAGE_EXTENSIONS.has((name ?? "").split(".").pop()?.toLowerCase() ?? "");

export class TelegramMessenger implements Messenger {
  readonly platform = "tg" as const;
  readonly maxUploadBytes = TG_UPLOAD_LIMIT;
  readonly bot: Bot;

  constructor(
    private readonly token: string,
    private readonly app: App,
    private readonly log: Logger,
  ) {
    // Long polling ждёт до 30 с; дольше 75 с — сеть не отвечает, а не «ждём событий».
    this.bot = new Bot(token, { client: { timeoutSeconds: 75 } });
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    this.wire();
  }

  // ── Messenger ──

  async sendText(chatId: number, text: string, keyboard?: Keyboard): Promise<string> {
    const m = await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: markup(keyboard) } : {}) });
    return String(m.message_id);
  }

  async editText(chatId: number, messageId: string, text: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, Number(messageId), text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup(keyboard) });
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
      throw err;
    }
  }

  async sendFiles(chatId: number, files: OutFile[]): Promise<string[]> {
    const ids: string[] = [];
    for (const group of albums(files)) {
      if (group.length === 1) {
        const f = group[0]!;
        const m = await this.bot.api.sendDocument(chatId, new InputFile(f.bytes, f.name), { disable_content_type_detection: true });
        ids.push(String(m.message_id));
        continue;
      }
      const media: InputMediaDocument[] = group.map((f) => ({ type: "document", media: new InputFile(f.bytes, f.name), disable_content_type_detection: true }));
      const sent = await this.bot.api.sendMediaGroup(chatId, media);
      ids.push(...sent.map((m) => String(m.message_id)));
    }
    return ids;
  }

  async deleteMessages(chatId: number, messageIds: string[]): Promise<void> {
    const ids = messageIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (!ids.length) return;
    // Старше 48 часов или уже удалено — Telegram откажет; это не ошибка бота.
    await this.bot.api.deleteMessages(chatId, ids).catch((err: unknown) => this.log.debug({ err }, "delete failed"));
  }

  // ── входящие ──

  private person(ctx: Context): Person | null {
    const f = ctx.from;
    if (!f || f.is_bot) return null;
    return { platform: "tg", id: f.id, firstName: f.first_name ?? null, username: f.username ?? null };
  }

  private incoming(msg: Message): { files: IncomingFile[]; rejected: string[] } {
    const files: IncomingFile[] = [];
    const rejected: string[] = [];
    const doc = msg.document;
    if (doc) {
      const name = doc.file_name || `file_${msg.message_id}`;
      if (isImageDocument(doc.mime_type, doc.file_name)) files.push(this.file(doc.file_id, name, doc.file_size ?? null, false));
      else rejected.push(name);
    }
    const photo = msg.photo?.at(-1);
    if (photo) files.push(this.file(photo.file_id, `photo_${msg.message_id}.jpg`, photo.file_size ?? null, true));
    return { files, rejected };
  }

  private file(fileId: string, name: string, size: number | null, compressed: boolean): IncomingFile {
    return {
      name,
      size,
      compressed,
      fetch: async () => {
        if (size != null && size > TG_DOWNLOAD_LIMIT) throw new DownloadError("больше 20 МБ — Telegram не отдаёт ботам файлы крупнее");
        let path: string | undefined;
        try {
          path = (await this.bot.api.getFile(fileId)).file_path;
        } catch (err) {
          if (err instanceof GrammyError && /too big/i.test(err.description)) throw new DownloadError("больше 20 МБ — Telegram не отдаёт ботам файлы крупнее");
          throw err;
        }
        if (!path) throw new DownloadError("Telegram не отдал файл, пришли ещё раз");
        const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${path}`, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new DownloadError(`Telegram не отдал файл (HTTP ${res.status}), пришли ещё раз`);
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  private wire(): void {
    const bot = this.bot;
    bot.chatType("private").on("message", async (ctx) => {
      const p = this.person(ctx);
      if (!p) return;
      const msg = ctx.message;
      const { files, rejected } = this.incoming(msg);
      if (files.length) this.app.onFiles(p, files, msg.caption ?? null);
      if (rejected.length) await ctx.reply(`Это не картинка: ${rejected.join(", ")}. Пришли JPG, PNG, WebP или TIFF.`);
      if (!files.length && !rejected.length) {
        if (msg.text) await this.app.onText(p, msg.text);
        else await ctx.reply("Пришли фото файлом (📎 → Файл) — поставлю вотермарку.");
      }
    });
    bot.on("callback_query:data", async (ctx) => {
      const p = this.person(ctx);
      let toast: string | undefined;
      try {
        if (p) toast = await this.app.onCallback(p, ctx.callbackQuery.data, ctx.callbackQuery.message ? String(ctx.callbackQuery.message.message_id) : null);
      } finally {
        await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => undefined);
      }
    });
    bot.catch((err) => this.log.error({ err: err.error, update: err.ctx.update.update_id }, "telegram handler failed"));
  }

  async start(): Promise<void> {
    // autoRetry повторяет сетевые ошибки молча — скажем в лог, что ждём.
    const slow = setTimeout(() => this.log.warn("telegram not reachable yet, retrying"), 30_000);
    const me = await this.bot.api.getMe().finally(() => clearTimeout(slow));
    this.log.info({ id: me.id, username: me.username }, "telegram bot authorised");
    await this.bot.api.setMyCommands(COMMANDS).catch((err: unknown) => this.log.warn({ err }, "telegram commands not set"));
    void this.bot.start({ allowed_updates: ["message", "callback_query"], onStart: () => this.log.info("polling telegram") }).catch((err: unknown) => this.log.fatal({ err }, "telegram polling stopped"));
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
