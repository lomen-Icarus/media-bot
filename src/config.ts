import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Простой загрузчик .env без зависимостей: строки KEY=VALUE, # — комментарий.
 * Повтор ключа: действует последняя строка, но пустая заполненную не перебивает.
 * Переменная окружения главнее файла, если она не пустая.
 */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value !== "" || !out.get(key)) out.set(key, value);
  }
  return out;
}

export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const [key, value] of parseDotEnv(readFileSync(file, "utf8"))) {
    if (process.env[key] === undefined || (process.env[key] === "" && value !== "")) process.env[key] = value;
  }
}

/** Список id через запятую или пробел; мусор отбрасывается. */
const idList = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );

/** Пустая строка в .env или панели — «не задано». */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const blankToUndefined = (v: unknown): unknown => (typeof v === "string" && !v.trim() ? undefined : v);
const num = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(blankToUndefined, inner);

const schema = z
  .object({
    BOT_TOKEN: optionalString,
    MAX_BOT_TOKEN: optionalString,
    TG_ADMIN_IDS: idList,
    MAX_ADMIN_IDS: idList,
    TG_ALLOWED_IDS: idList,
    MAX_ALLOWED_IDS: idList,
    DATA_DIR: z.string().default("./data"),
    /** Сколько часов бот хранит присланные фото, чтобы переделать их кнопками. */
    BATCH_TTL_HOURS: num(z.coerce.number().min(0.1).max(72).default(6)),
    HTTPS_PROXY: optionalString,
    LOG_LEVEL: z.string().optional(),
  })
  .refine((c) => c.BOT_TOKEN || c.MAX_BOT_TOKEN, { message: "нужен BOT_TOKEN (Telegram) или MAX_BOT_TOKEN (МАКС) — хотя бы один" });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new Error(`Ошибка настроек (.env): ${issues}`);
  }
  return parsed.data;
}
