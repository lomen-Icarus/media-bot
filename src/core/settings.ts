/**
 * Настройки вотермарки человека: где, какого размера и насколько прозрачная.
 * Значения — короткие коды: они едут в данных кнопок (у Telegram лимит 64 байта).
 */

/** Девять мест: t/m/b — верх/середина/низ, l/c/r — лево/центр/право. */
export const POSITIONS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_ICON: Record<Position, string> = {
  tl: "↖️",
  tc: "⬆️",
  tr: "↗️",
  ml: "⬅️",
  mc: "⏺",
  mr: "➡️",
  bl: "↙️",
  bc: "⬇️",
  br: "↘️",
};

export const POSITION_LABEL: Record<Position, string> = {
  tl: "слева сверху",
  tc: "сверху по центру",
  tr: "справа сверху",
  ml: "слева посередине",
  mc: "по центру",
  mr: "справа посередине",
  bl: "слева снизу",
  bc: "снизу по центру",
  br: "справа снизу",
};

/** Размер — длинная сторона вотермарки в % от короткой стороны фото: на вертикальных и горизонтальных одинаково. */
export const SIZES = [10, 15, 20, 30, 45, 60] as const;
/** Непрозрачность, %. */
export const OPACITIES = [100, 80, 60, 40, 25] as const;

/** Отступ от края — в % от короткой стороны фото (по центру отступа нет). */
export const MARGIN_PCT = 3;

export interface WatermarkSettings {
  position: Position;
  size: number;
  opacity: number;
}

export const DEFAULT_SETTINGS: WatermarkSettings = { position: "br", size: 20, opacity: 100 };

export function isPosition(v: string): v is Position {
  return (POSITIONS as readonly string[]).includes(v);
}

export const sizeLabel = (size: number): string => `${size}%`;
export const opacityLabel = (opacity: number): string => (opacity >= 100 ? "без прозрачности" : `видно на ${opacity}%`);
