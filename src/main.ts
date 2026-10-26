/**
 * Запуск: одна база и одно ядро, к нему — Telegram (BOT_TOKEN) и МАКС
 * (MAX_BOT_TOKEN), что задано. Один мессенджер не поднялся — другой работает.
 */
import path from "node:path";
import { App } from "./core/app.js";
import { BatchStore } from "./core/batches.js";
import type { UserKey } from "./core/types.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { Store } from "./db/store.js";
import { logger } from "./logger.js";
import { MaxApi, MaxApiError } from "./max/api.js";
import { MaxMessenger } from "./max/adapter.js";
import { TelegramMessenger } from "./tg/adapter.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const dataDir = path.resolve(config.DATA_DIR);
  const store = Store.open(path.join(dataDir, "media-bot.sqlite"));
  const batches = new BatchStore(path.join(dataDir, "batches"), config.BATCH_TTL_HOURS * 3600_000);
  const keys = (platform: "tg" | "max", ids: number[]): UserKey[] => ids.map((id) => ({ platform, id }));
  const app = new App({
    store,
    batches,
    log: logger,
    admins: [...keys("tg", config.TG_ADMIN_IDS), ...keys("max", config.MAX_ADMIN_IDS)],
    envAllowed: [...keys("tg", config.TG_ALLOWED_IDS), ...keys("max", config.MAX_ALLOWED_IDS)],
  });
  logger.info({ watermarks: store.watermarks().length, admins: config.TG_ADMIN_IDS.length + config.MAX_ADMIN_IDS.length }, "media-bot starting");

  const tg = config.BOT_TOKEN ? new TelegramMessenger(config.BOT_TOKEN, app, logger) : null;
  const max = config.MAX_BOT_TOKEN
    ? new MaxMessenger(new MaxApi({ token: config.MAX_BOT_TOKEN, ...(config.HTTPS_PROXY ? { proxyUrl: config.HTTPS_PROXY } : {}) }), app, store, logger)
    : null;
  if (!tg) logger.info("telegram disabled: BOT_TOKEN not set");
  if (!max) logger.info("MAX disabled: MAX_BOT_TOKEN not set");

  const shutdown = async (): Promise<void> => {
    logger.info("stopping");
    max?.stop();
    await tg?.stop().catch(() => undefined);
    batches.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Каждый сам по себе: один недоступен — второй работает; оба переподключаются сами.
  if (tg) {
    app.register(tg);
    void tg.start().catch((err: unknown) => logger.error({ err }, "telegram not started"));
  }
  if (max) {
    app.register(max);
    void max.start().catch((err: unknown) => logger.error({ err: err instanceof MaxApiError ? `${err.status} ${err.code}` : String(err).slice(0, 200) }, "MAX not started"));
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "fatal");
  process.exit(1);
});
