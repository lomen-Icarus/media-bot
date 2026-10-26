/**
 * Пачка присланных фото: оригиналы лежат на диске BATCH_TTL_HOURS, чтобы
 * кнопки «Место / Размер / …» под результатом переделали те же фото без
 * повторной отправки. Потом удаляются. После перезапуска бота пачек нет.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { UserKey } from "./types.js";

export interface BatchFile {
  name: string;
  path: string;
  compressed: boolean;
}

export interface Batch {
  id: string;
  owner: UserKey;
  files: BatchFile[];
  /** Ошибки скачивания — показываются под каждым результатом этой пачки. */
  downloadErrors: string[];
  /** Сообщения с готовыми файлами и сообщение с кнопками под ними. */
  outIds: string[];
  /** Сколько файлов в последнем результате (в МАКС несколько файлов — одно сообщение). */
  done: number;
  controlId: string | null;
  createdAt: number;
  /** Идёт переделка — новые нажатия ждут. */
  busy: boolean;
}

export class BatchStore {
  private readonly batches = new Map<string, Batch>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
  ) {
    // Остатки прошлого запуска: в памяти о них ничего нет.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.sweep(), 10 * 60_000);
    this.timer.unref();
  }

  create(owner: UserKey, files: Array<{ name: string; bytes: Buffer; compressed: boolean }>, downloadErrors: string[]): Batch {
    let id: string;
    do id = randomBytes(5).toString("base64url").slice(0, 6);
    while (this.batches.has(id));
    const dir = path.join(this.dir, id);
    mkdirSync(dir, { recursive: true });
    const saved = files.map((f, i) => {
      const p = path.join(dir, String(i));
      writeFileSync(p, f.bytes);
      return { name: f.name, path: p, compressed: f.compressed };
    });
    const batch: Batch = { id, owner, files: saved, downloadErrors, outIds: [], done: 0, controlId: null, createdAt: Date.now(), busy: false };
    this.batches.set(id, batch);
    return batch;
  }

  /** Пачка этого человека; чужую или устаревшую не отдаём. */
  get(id: string, owner: UserKey): Batch | null {
    const b = this.batches.get(id);
    if (!b || b.owner.platform !== owner.platform || b.owner.id !== owner.id) return null;
    if (Date.now() - b.createdAt > this.ttlMs) {
      this.drop(id);
      return null;
    }
    return b;
  }

  read(f: BatchFile): Buffer {
    return readFileSync(f.path);
  }

  drop(id: string): void {
    this.batches.delete(id);
    rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  sweep(): void {
    const t = Date.now();
    for (const b of [...this.batches.values()]) if (t - b.createdAt > this.ttlMs && !b.busy) this.drop(b.id);
  }

  close(): void {
    clearInterval(this.timer);
  }
}
