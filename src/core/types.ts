/**
 * Общий язык ядра и мессенджеров. Ядро (app.ts) не знает, Telegram это или
 * МАКС: адаптеры (src/tg, src/max) переводят события в вызовы App и
 * выполняют его ответы через Messenger.
 */

export type Platform = "tg" | "max";

export const PLATFORM_LABEL: Record<Platform, string> = { tg: "Telegram", max: "МАКС" };

/** Человек: мессенджер + id в нём. Личный диалог адресуется тем же id. */
export interface UserKey {
  platform: Platform;
  id: number;
}

export const userKeyString = (k: UserKey): string => `${k.platform}:${k.id}`;

export function parseUserKey(s: string): UserKey | null {
  const m = /^(tg|max):(\d{1,20})$/.exec(s);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { platform: m[1] as Platform, id } : null;
}

export interface Person extends UserKey {
  firstName: string | null;
  username: string | null;
}

/** Кнопка под сообщением: текст и данные нажатия. */
export interface Button {
  text: string;
  data: string;
}
export type Keyboard = Button[][];

/** Присланный файл: имя, размер (если мессенджер сказал) и как его скачать. */
export interface IncomingFile {
  name: string;
  size: number | null;
  /** Мессенджер сжал картинку (в Telegram — отправлено «как фото», а не файлом). */
  compressed: boolean;
  /** Скачать байты; бросает DownloadError с понятным текстом. */
  fetch: () => Promise<Buffer>;
}

export interface OutFile {
  name: string;
  bytes: Buffer;
  mime: string;
}

/** Ошибка скачивания, понятная человеку. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Что ядро умеет делать в мессенджере. id сообщений — строки (у МАКС это mid). */
export interface Messenger {
  readonly platform: Platform;
  /** Самый большой файл, который бот может отправить (у Telegram — 50 МБ). */
  readonly maxUploadBytes: number;
  /** text — простой HTML: <b>, <i>, <code>. */
  sendText(chatId: number, text: string, keyboard?: Keyboard): Promise<string>;
  editText(chatId: number, messageId: string, text: string, keyboard?: Keyboard): Promise<void>;
  /** Файлы — документами, без пересжатия мессенджером. Возвращает id всех отправленных сообщений. */
  sendFiles(chatId: number, files: OutFile[]): Promise<string[]>;
  /** Удалить свои сообщения; ошибки (уже удалено, слишком старое) молча пропускаются. */
  deleteMessages(chatId: number, messageIds: string[]): Promise<void>;
}
