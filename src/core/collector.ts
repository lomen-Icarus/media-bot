/**
 * Альбом приходит в мессенджер не одним событием, а пачкой (в Telegram —
 * сообщение на каждое фото). Собираем файлы человека, пока он не замолчит на
 * QUIET_MS, и отдаём одной пачкой; больше 10 — несколькими по 10.
 */
import type { IncomingFile, Person } from "./types.js";

export const MAX_BATCH = 10;
const QUIET_MS = 1500;
/** Даже если файлы всё идут — не ждать дольше. */
const MAX_WAIT_MS = 8000;

export interface Collected {
  person: Person;
  files: IncomingFile[];
  caption: string | null;
}

interface Pending extends Collected {
  timer: NodeJS.Timeout;
  firstAt: number;
}

export class FileCollector {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly flush: (c: Collected) => void,
    private readonly quietMs = QUIET_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  add(person: Person, files: IncomingFile[], caption: string | null): void {
    const key = `${person.platform}:${person.id}`;
    const p = this.pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      p.files.push(...files);
      p.caption ??= caption;
      p.person = person;
      p.timer = this.schedule(key, Math.max(0, Math.min(this.quietMs, p.firstAt + this.maxWaitMs - Date.now())));
      return;
    }
    this.pending.set(key, { person, files: [...files], caption, firstAt: Date.now(), timer: this.schedule(key, this.quietMs) });
  }

  private schedule(key: string, ms: number): NodeJS.Timeout {
    return setTimeout(() => {
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      this.flush({ person: p.person, files: p.files, caption: p.caption });
    }, ms);
  }
}

/** Режет список на куски по n. */
export function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Очередь «по одному»: картинки тяжёлые, параллельно на маленьком сервере кончится память. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
