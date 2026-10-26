/**
 * База бота (встроенный node:sqlite, без нативных модулей): люди обоих
 * мессенджеров с доступом и настройками, библиотека вотермарок, счётчики.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS, isPosition, type WatermarkSettings } from "../core/settings.js";
import type { Platform, UserKey } from "../core/types.js";
import { MIGRATIONS } from "./migrations.js";

export type Access = "none" | "pending" | "allowed" | "denied";

export interface UserRow {
  platform: Platform;
  extId: number;
  firstName: string | null;
  username: string | null;
  access: Access;
  requestedAt: string | null;
  watermarkId: number | null;
  settings: WatermarkSettings;
}

export interface WatermarkInfo {
  id: number;
  name: string;
  width: number;
  height: number;
}

const now = (): string => new Date().toISOString();
const today = (): string => now().slice(0, 10);

type Row = Record<string, unknown>;

function toUser(r: Row): UserRow {
  const position = String(r.position ?? "");
  return {
    platform: r.platform as Platform,
    extId: Number(r.ext_id),
    firstName: (r.first_name as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    access: r.access as Access,
    requestedAt: (r.requested_at as string | null) ?? null,
    watermarkId: r.watermark_id == null ? null : Number(r.watermark_id),
    settings: {
      position: isPosition(position) ? position : DEFAULT_SETTINGS.position,
      size: r.size == null ? DEFAULT_SETTINGS.size : Number(r.size),
      opacity: r.opacity == null ? DEFAULT_SETTINGS.opacity : Number(r.opacity),
    },
  };
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): Store {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const store = new Store(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ── meta ──
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ── люди ──
  /** Заводит или обновляет человека при каждом обращении (имя — для списка доступа у админа). */
  touchUser(key: UserKey, firstName: string | null, username: string | null): UserRow {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO users (platform, ext_id, first_name, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, ext_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, last_seen_at = excluded.last_seen_at`,
      )
      .run(key.platform, key.id, firstName, username, t, t);
    return this.user(key)!;
  }

  user(key: UserKey): UserRow | null {
    const r = this.db.prepare("SELECT * FROM users WHERE platform = ? AND ext_id = ?").get(key.platform, key.id) as Row | undefined;
    return r ? toUser(r) : null;
  }

  setAccess(key: UserKey, access: Access): void {
    this.db.prepare("UPDATE users SET access = ? WHERE platform = ? AND ext_id = ?").run(access, key.platform, key.id);
  }

  /** Человек попросил доступ: запоминаем время (чтобы не дёргать админов чаще раза в сутки). */
  markRequested(key: UserKey): void {
    this.db.prepare("UPDATE users SET access = 'pending', requested_at = ? WHERE platform = ? AND ext_id = ?").run(now(), key.platform, key.id);
  }

  /** Люди с доступом, выданным в боте (из .env сюда не попадают). */
  allowedUsers(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users WHERE access = 'allowed' ORDER BY platform, last_seen_at DESC").all() as Row[]).map(toUser);
  }

  setSettings(key: UserKey, patch: Partial<WatermarkSettings> & { watermarkId?: number | null }): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.position !== undefined) (sets.push("position = ?"), args.push(patch.position));
    if (patch.size !== undefined) (sets.push("size = ?"), args.push(patch.size));
    if (patch.opacity !== undefined) (sets.push("opacity = ?"), args.push(patch.opacity));
    if (patch.watermarkId !== undefined) (sets.push("watermark_id = ?"), args.push(patch.watermarkId));
    if (!sets.length) return;
    this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE platform = ? AND ext_id = ?`).run(...args, key.platform, key.id);
  }

  // ── вотермарки ──
  addWatermark(name: string, png: Uint8Array, width: number, height: number, addedBy: UserKey): number {
    const r = this.db
      .prepare("INSERT INTO watermarks (name, png, width, height, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, png, width, height, `${addedBy.platform}:${addedBy.id}`, now());
    return Number(r.lastInsertRowid);
  }

  watermarks(): WatermarkInfo[] {
    return (this.db.prepare("SELECT id, name, width, height FROM watermarks ORDER BY id").all() as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      width: Number(r.width),
      height: Number(r.height),
    }));
  }

  watermark(id: number): WatermarkInfo | null {
    const r = this.db.prepare("SELECT id, name, width, height FROM watermarks WHERE id = ?").get(id) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name), width: Number(r.width), height: Number(r.height) } : null;
  }

  watermarkPng(id: number): Buffer | null {
    const r = this.db.prepare("SELECT png FROM watermarks WHERE id = ?").get(id) as Row | undefined;
    return r ? Buffer.from(r.png as Uint8Array) : null;
  }

  /** У скольких людей эта вотермарка выбрана. */
  watermarkUsers(id: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE watermark_id = ?").get(id) as Row).n);
  }

  deleteWatermark(id: number): void {
    this.db.prepare("DELETE FROM watermarks WHERE id = ?").run(id);
    // Выбравшим её — «по умолчанию» (первая из оставшихся, см. App.watermarkFor).
    this.db.prepare("UPDATE users SET watermark_id = NULL WHERE watermark_id = ?").run(id);
  }

  // ── счётчики ──
  bump(key: string, n = 1): void {
    this.db.prepare("INSERT INTO stats (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n").run(today(), key, n);
  }

  /** Суммы счётчиков за последние `days` дней (включая сегодня). */
  stats(days: number): Map<string, number> {
    const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare("SELECT key, SUM(n) AS n FROM stats WHERE day >= ? GROUP BY key").all(from) as Row[];
    return new Map(rows.map((r) => [String(r.key), Number(r.n)]));
  }

  userCounts(): { allowed: number; pending: number; total: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS total, SUM(access = 'allowed') AS allowed, SUM(access = 'pending') AS pending FROM users").get() as Row;
    return { total: Number(r.total ?? 0), allowed: Number(r.allowed ?? 0), pending: Number(r.pending ?? 0) };
  }
}
