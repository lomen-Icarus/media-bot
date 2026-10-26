/**
 * Тексты и кнопки экранов. Чистые функции: всё нужное — в аргументах.
 *
 * Данные кнопок (коротко — у Telegram лимит 64 байта):
 *   st                  — настройки
 *   pk:<что>:<ctx>      — открыть выбор: w вотермарка, p место, z размер, o прозрачность
 *   sv:<что>:<v>:<ctx>  — выбрать значение
 *   bk:<ctx>            — назад
 *   ctx: «s» — экран настроек, иначе id пачки (кнопки под готовыми файлами)
 *   lib, la, lx, ld:<id>, ldy:<id> — библиотека вотермарок (админ)
 *   acc, ar:<кто>       — доступ (админ); ga:<кто>, gd:<кто> — пустить / не пускать
 */
import type { WatermarkInfo } from "../db/store.js";
import {
  OPACITIES,
  POSITIONS,
  POSITION_ICON,
  POSITION_LABEL,
  SIZES,
  opacityLabel,
  sizeLabel,
  type WatermarkSettings,
} from "./settings.js";
import type { Keyboard } from "./types.js";

export interface Screen {
  text: string;
  keyboard?: Keyboard;
}

export type PickerKind = "w" | "p" | "z" | "o";

/** Экранирование для HTML-разметки сообщений. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SEND_HINT = "Пришли от 1 до 10 фото <b>файлом</b> (📎 → Файл) — верну те же файлы с вотермаркой, без потери качества.";

/** «Лого», ↘️ справа снизу, 20% — одной строкой. */
export function summary(wm: WatermarkInfo | null, s: WatermarkSettings): string {
  const parts = [wm ? `«${esc(wm.name)}»` : "без вотермарки", `${POSITION_ICON[s.position]} ${POSITION_LABEL[s.position]}`, sizeLabel(s.size)];
  if (s.opacity < 100) parts.push(opacityLabel(s.opacity));
  return parts.join(", ");
}

export function startScreen(wm: WatermarkInfo | null, s: WatermarkSettings, libraryEmpty: boolean): Screen {
  const now = libraryEmpty ? "В базе пока нет вотермарок — их добавляет админ." : `Сейчас ставлю: ${summary(wm, s)}.`;
  return { text: `👋 Ставлю вотермарку на фото.\n\n${SEND_HINT}\n\n${now}`, keyboard: [[{ text: "⚙️ Настройки", data: "st" }]] };
}

export function settingsScreen(wm: WatermarkInfo | null, s: WatermarkSettings, opts: { admin: boolean; libraryEmpty: boolean }): Screen {
  const lines = [
    "⚙️ <b>Как ставлю вотермарку</b>",
    "",
    `🖼 ${opts.libraryEmpty ? "в базе пока нет вотермарок" : wm ? `«${esc(wm.name)}»` : "—"}`,
    `📍 ${POSITION_ICON[s.position]} ${POSITION_LABEL[s.position]}`,
    `📏 ${sizeLabel(s.size)} от короткой стороны фото`,
    `🌫 ${opacityLabel(s.opacity)}`,
    "",
    SEND_HINT,
  ];
  const keyboard: Keyboard = [
    [
      { text: "🖼 Вотермарка", data: "pk:w:s" },
      { text: "📍 Место", data: "pk:p:s" },
    ],
    [
      { text: "📏 Размер", data: "pk:z:s" },
      { text: "🌫 Прозрачность", data: "pk:o:s" },
    ],
  ];
  if (opts.admin) {
    keyboard.push([
      { text: "🗂 Вотермарки в базе", data: "lib" },
      { text: "👥 Доступ", data: "acc" },
    ]);
  }
  return { text: lines.join("\n"), keyboard };
}

/** Кнопки под готовыми файлами: поменять — и та же пачка переделается. */
export function resultScreen(
  ctx: string,
  done: number,
  wm: WatermarkInfo | null,
  s: WatermarkSettings,
  notes: { errors: string[]; compressed: number; platform: "tg" | "max"; watermarks: number },
): Screen {
  const lines = [`✅ Готово: ${done} ${plural(done, "фото", "фото", "фото")} — ${summary(wm, s)}.`];
  if (notes.errors.length) lines.push("", `⚠️ Не получилось (${notes.errors.length}):`, ...notes.errors.map((e) => `• ${e}`));
  if (notes.compressed > 0 && notes.platform === "tg") {
    lines.push("", "ℹ️ Telegram сжал присланные фото. Для исходного качества отправляй <b>файлом</b>: 📎 → Файл.");
  }
  lines.push("", "Не так? Поменяй — переделаю эти же фото и запомню.");
  const row2 = [{ text: "🌫 Прозрачность", data: `pk:o:${ctx}` }];
  if (notes.watermarks > 1) row2.unshift({ text: "🖼 Вотермарка", data: `pk:w:${ctx}` });
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "📍 Место", data: `pk:p:${ctx}` },
        { text: "📏 Размер", data: `pk:z:${ctx}` },
      ],
      row2,
    ],
  };
}

const mark = (on: boolean, text: string): string => (on ? `✅ ${text}` : text);

export function pickerScreen(kind: PickerKind, ctx: string, current: WatermarkSettings & { watermarkId: number | null }, library: WatermarkInfo[]): Screen {
  const back = [{ text: "◀️ Назад", data: `bk:${ctx}` }];
  if (kind === "p") {
    const rows: Keyboard = [];
    for (let r = 0; r < 3; r++) {
      rows.push(
        POSITIONS.slice(r * 3, r * 3 + 3).map((p) => ({ text: p === current.position ? "✅" : POSITION_ICON[p], data: `sv:p:${p}:${ctx}` })),
      );
    }
    return { text: `📍 <b>Где поставить вотермарку?</b>\nСейчас: ${POSITION_LABEL[current.position]}.`, keyboard: [...rows, back] };
  }
  if (kind === "z") {
    const buttons = SIZES.map((z) => ({ text: mark(z === current.size, sizeLabel(z)), data: `sv:z:${z}:${ctx}` }));
    return {
      text: `📏 <b>Какого размера?</b>\nПроцент — длинная сторона вотермарки от короткой стороны фото: на вертикальных и горизонтальных одинаково.\nСейчас: ${sizeLabel(current.size)}.`,
      keyboard: [buttons.slice(0, 3), buttons.slice(3), back],
    };
  }
  if (kind === "o") {
    const buttons = OPACITIES.map((o) => ({ text: mark(o === current.opacity, `${o}%`), data: `sv:o:${o}:${ctx}` }));
    return {
      text: `🌫 <b>Насколько видна вотермарка?</b>\n100% — как есть, меньше — просвечивает фото.\nСейчас: ${opacityLabel(current.opacity)}.`,
      keyboard: [buttons.slice(0, 3), buttons.slice(3), back],
    };
  }
  // Вотермарка из базы.
  if (!library.length) return { text: "🖼 В базе пока нет вотермарок — их добавляет админ.", keyboard: [back] };
  const selected = current.watermarkId ?? library[0]!.id;
  const rows: Keyboard = library.slice(0, 24).map((w) => [{ text: mark(w.id === selected, w.name), data: `sv:w:${w.id}:${ctx}` }]);
  return { text: "🖼 <b>Какую вотермарку ставить?</b>", keyboard: [...rows, back] };
}

export function libraryScreen(library: WatermarkInfo[]): Screen {
  const lines = ["🗂 <b>Вотермарки в базе</b>", ""];
  if (!library.length) lines.push("Пока пусто.");
  else library.forEach((w, i) => lines.push(`${i + 1}. ${esc(w.name)} — ${w.width}×${w.height}`));
  lines.push("", "Добавить — «➕», потом прислать PNG с прозрачным фоном <b>файлом</b>. Подпись к файлу станет названием.");
  const keyboard: Keyboard = library.slice(0, 20).map((w) => [{ text: `🗑 ${w.name}`, data: `ld:${w.id}` }]);
  keyboard.push([
    { text: "➕ Добавить", data: "la" },
    { text: "◀️ Назад", data: "st" },
  ]);
  return { text: lines.join("\n"), keyboard };
}

export function addWatermarkScreen(): Screen {
  return {
    text: "➕ Пришли вотермарку <b>файлом</b> (📎 → Файл): PNG с прозрачным фоном, чем крупнее — тем чётче на больших фото.\nПодпись к файлу станет названием, без подписи — имя файла. Можно несколько сразу.",
    keyboard: [[{ text: "✖️ Отмена", data: "lx" }]],
  };
}

export function deleteConfirmScreen(wm: WatermarkInfo, users: number): Screen {
  const who = users ? `\nОна выбрана у ${users} ${plural(users, "человека", "человек", "человек")} — им встанет первая из оставшихся.` : "";
  return {
    text: `🗑 Удалить «${esc(wm.name)}» из базы?${who}`,
    keyboard: [
      [
        { text: "🗑 Да, удалить", data: `ldy:${wm.id}` },
        { text: "◀️ Назад", data: "lib" },
      ],
    ],
  };
}

export interface AccessEntry {
  key: string;
  label: string;
}

export function accessScreen(envCounts: { tg: number; max: number }, granted: AccessEntry[]): Screen {
  const lines = ["👥 <b>Доступ</b>", "", `Из .env: Telegram — ${envCounts.tg}, МАКС — ${envCounts.max} (меняются только в .env).`, `Выдан в боте: ${granted.length}.`];
  if (granted.length) lines.push("", ...granted.slice(0, 30).map((g) => `• ${g.label}`), "", "❌ — закрыть доступ (человек сможет попросить снова).");
  lines.push("", "Новые люди просят доступ сами: пишут боту — админам приходит запрос с кнопкой «✅ Пустить».");
  const keyboard: Keyboard = granted.slice(0, 20).map((g) => [{ text: `❌ ${g.label}`, data: `ar:${g.key}` }]);
  keyboard.push([{ text: "◀️ Назад", data: "st" }]);
  return { text: lines.join("\n"), keyboard };
}

/** 1 фото, 2 фото, 5 фото / 1 человека, 2 человек … — род. падеж после «у». */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
