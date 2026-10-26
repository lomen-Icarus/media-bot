import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as realSleep } from "node:timers/promises";
import path from "node:path";
import pino from "pino";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app.js";
import { BatchStore } from "../src/core/batches.js";
import { DownloadError, type IncomingFile, type Keyboard, type Messenger, type OutFile, type Person, type Platform } from "../src/core/types.js";
import { Store } from "../src/db/store.js";
import { prepareWatermark } from "../src/image/watermark.js";
import { albums } from "../src/tg/adapter.js";

interface Sent {
  id: string;
  chat: number;
  text?: string;
  keyboard?: Keyboard;
  files?: OutFile[];
}

class FakeMessenger implements Messenger {
  readonly maxUploadBytes = 50 * 1024 * 1024;
  sent: Sent[] = [];
  edits: Array<{ id: string; text: string; keyboard?: Keyboard }> = [];
  deleted: string[] = [];
  private n = 0;
  constructor(readonly platform: Platform) {}
  async sendText(chat: number, text: string, keyboard?: Keyboard): Promise<string> {
    const id = String(++this.n);
    this.sent.push({ id, chat, text, ...(keyboard ? { keyboard } : {}) });
    return id;
  }
  async editText(_chat: number, id: string, text: string, keyboard?: Keyboard): Promise<void> {
    this.edits.push({ id, text, ...(keyboard ? { keyboard } : {}) });
  }
  async sendFiles(chat: number, files: OutFile[]): Promise<string[]> {
    return files.map((f) => {
      const id = String(++this.n);
      this.sent.push({ id, chat, files: [f] });
      return id;
    });
  }
  async deleteMessages(_chat: number, ids: string[]): Promise<void> {
    this.deleted.push(...ids);
  }
  lastText(): Sent {
    return [...this.sent].reverse().find((s) => s.text !== undefined)!;
  }
  fileMessages(): Sent[] {
    return this.sent.filter((s) => s.files && !this.deleted.includes(s.id));
  }
}

const ADMIN: Person = { platform: "tg", id: 1, firstName: "Админ", username: "admin" };
const MEMBER: Person = { platform: "max", id: 500, firstName: "Ира", username: null };

async function jpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#2050a0" } }).jpeg({ quality: 95 }).toBuffer();
}

const file = (name: string, bytes: Buffer, compressed = false): IncomingFile => ({ name, size: bytes.length, compressed, fetch: async () => bytes });

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  // Дать доработать цепочкам промисов с sharp (они вне фейкового таймера).
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

/** Ждать, пока условие не станет правдой: sharp работает в своём потоке, по настоящим часам. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await tick(10);
    await realSleep(10);
  }
  expect(cond()).toBe(true);
}

describe("путь человека", () => {
  let dir: string;
  let store: Store;
  let batches: BatchStore;
  let tg: FakeMessenger;
  let max: FakeMessenger;
  let app: App;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    dir = mkdtempSync(path.join(tmpdir(), "media-bot-"));
    store = Store.open(":memory:");
    batches = new BatchStore(path.join(dir, "batches"), 3600_000);
    app = new App({ store, batches, log: pino({ level: "silent" }), admins: [{ platform: "tg", id: 1 }], envAllowed: [] });
    tg = new FakeMessenger("tg");
    max = new FakeMessenger("max");
    app.register(tg);
    app.register(max);
    const logo = await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.8 } } }).png().toBuffer();
    const w = await prepareWatermark(logo);
    store.addWatermark("Лого ВИШ", w.png, w.width, w.height, ADMIN);
  });

  afterEach(() => {
    vi.useRealTimers();
    batches.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("чужой просит доступ из МАКС, админ пускает из Telegram", async () => {
    await app.onText(MEMBER, "/start");
    expect(max.lastText().text).toContain("Отправил админам запрос");
    const request = tg.lastText();
    expect(request.text).toContain("Ира");
    expect(request.keyboard?.[0]?.[0]?.data).toBe("ga:max:500");

    // Повторное сообщение не дёргает админов снова.
    await app.onText(MEMBER, "привет");
    expect(tg.sent.filter((s) => s.text?.includes("Просит доступ"))).toHaveLength(1);

    const toast = await app.onCallback(ADMIN, "ga:max:500", request.id);
    expect(toast).toBe("Пустил");
    expect(tg.edits.at(-1)?.text).toContain("Пустил");
    expect(max.lastText().text).toContain("Доступ открыт");
  });

  it("альбом из 3 фото → 3 файла с вотермаркой и кнопки; смена места переделывает ту же пачку", async () => {
    store.touchUser(MEMBER, "Ира", null);
    store.setAccess(MEMBER, "allowed");
    // Альбом приходит тремя событиями.
    app.onFiles(MEMBER, [file("IMG_1.jpg", await jpeg(800, 600))], "подпись");
    app.onFiles(MEMBER, [file("IMG_2.jpg", await jpeg(600, 800))], null);
    app.onFiles(MEMBER, [file("IMG_3.JPG", await jpeg(640, 640))], null);
    await tick(1600);
    await until(() => max.sent.some((s) => s.text?.startsWith("✅ Готово")));

    const first = max.fileMessages();
    expect(first.map((s) => s.files![0]!.name)).toEqual(["IMG_1_wm.jpg", "IMG_2_wm.jpg", "IMG_3_wm.JPG"]);
    const meta = await sharp(first[1]!.files![0]!.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([600, 800]);
    const control = max.lastText();
    expect(control.text).toContain("3 фото");
    expect(control.text).toContain("справа снизу");
    // «⏳» убран после отправки.
    expect(max.deleted).toContain(max.sent.find((s) => s.text?.startsWith("⏳"))!.id);

    // 📍 Место → ↙️: экран выбора на месте кнопок, потом переделка.
    const pick = control.keyboard!.flat().find((b) => b.text.includes("Место"))!;
    await app.onCallback(MEMBER, pick.data, control.id);
    const grid = max.edits.at(-1)!;
    expect(grid.keyboard).toHaveLength(4);
    const bl = grid.keyboard!.flat().find((b) => b.data.startsWith("sv:p:bl:"))!;
    const toast = await app.onCallback(MEMBER, bl.data, control.id);
    expect(toast).toBe("Место: слева снизу");
    await until(() => max.sent.filter((s) => s.text?.startsWith("✅ Готово")).length === 2);

    // Старые файлы и старые кнопки удалены, новые — на месте.
    for (const s of first) expect(max.deleted).toContain(s.id);
    expect(max.deleted).toContain(control.id);
    expect(max.fileMessages()).toHaveLength(3);
    expect(max.lastText().text).toContain("слева снизу");
    // Выбор запомнился.
    expect(store.user(MEMBER)!.settings.position).toBe("bl");
  });

  it("сжатое Telegram фото — подсказка отправлять файлом; ошибка скачивания — в списке", async () => {
    const broken: IncomingFile = {
      name: "big.jpg",
      size: 30 * 1024 * 1024,
      compressed: false,
      fetch: async () => {
        throw new DownloadError("больше 20 МБ — Telegram не отдаёт ботам файлы крупнее");
      },
    };
    app.onFiles(ADMIN, [file("photo_1.jpg", await jpeg(320, 240), true), broken], null);
    await tick(1600);
    await until(() => tg.sent.some((s) => s.text?.startsWith("✅ Готово")));
    const control = tg.lastText().text!;
    expect(control).toContain("1 фото");
    expect(control).toContain("big.jpg — больше 20 МБ");
    expect(control).toContain("Telegram сжал");
  });

  it("админ добавляет вотермарку файлом: подпись — название; сжатое фото не берётся", async () => {
    await app.onCallback(ADMIN, "la", null);
    const png = await sharp({ create: { width: 120, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    app.onFiles(ADMIN, [file("logo.png", png), file("photo.jpg", await jpeg(50, 50), true)], "Медиа ВИШ");
    await tick(1600);
    await until(() => tg.sent.some((s) => s.text?.includes("Добавление в базу")));
    const report = tg.lastText().text!;
    expect(report).toContain("«Медиа ВИШ»");
    expect(report).toContain("пришло сжатым фото");
    expect(store.watermarks().map((w) => w.name)).toEqual(["Лого ВИШ", "Медиа ВИШ"]);
    // Следующие фото — уже снова на обработку, не в базу.
    app.onFiles(ADMIN, [file("x.jpg", await jpeg(100, 100))], null);
    await tick(1600);
    await until(() => tg.sent.some((s) => s.text?.startsWith("✅ Готово")));
  });

  it("не админ не видит кнопок админа и не может их нажать", async () => {
    store.touchUser(MEMBER, "Ира", null);
    store.setAccess(MEMBER, "allowed");
    await app.onText(MEMBER, "/settings");
    expect(max.lastText().keyboard!.flat().map((b) => b.data)).not.toContain("lib");
    await app.onCallback(MEMBER, "ldy:1", null);
    expect(store.watermarks()).toHaveLength(1);
    expect(await app.onCallback(MEMBER, "ga:max:500", null)).toBeUndefined();
  });
});

describe("альбомы Telegram", () => {
  const f = (mb: number): OutFile => ({ name: "a.jpg", bytes: Buffer.alloc(mb * 1024 * 1024), mime: "image/jpeg" });
  it("по 10 файлов и не больше 50 МБ на запрос", () => {
    expect(albums(Array.from({ length: 12 }, () => f(1))).map((a) => a.length)).toEqual([10, 2]);
    expect(albums([f(20), f(20), f(20), f(5)]).map((a) => a.length)).toEqual([2, 2]);
  });
});
