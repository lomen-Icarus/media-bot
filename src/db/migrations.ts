/** Миграции схемы по порядку. Выпущенные не править — только дописывать в конец. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Люди обоих мессенджеров: platform — 'tg' или 'max', ext_id — id в мессенджере.
  CREATE TABLE users (
    platform TEXT NOT NULL,
    ext_id INTEGER NOT NULL,
    first_name TEXT,
    username TEXT,
    access TEXT NOT NULL DEFAULT 'none',
    requested_at TEXT,
    watermark_id INTEGER,
    position TEXT,
    size INTEGER,
    opacity INTEGER,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (platform, ext_id)
  );

  CREATE TABLE watermarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    png BLOB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Счётчики по дням для /stats: сколько фото, пачек и какие кнопки жмут.
  CREATE TABLE stats (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  );
  `,
];
