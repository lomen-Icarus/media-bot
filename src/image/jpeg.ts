/**
 * Качество JPEG по его таблице квантования: в файле самого числа «качество»
 * нет, но таблица яркости у libjpeg — стандартная, умноженная на коэффициент
 * качества. Ищем качество, при котором стандартная таблица ближе всего к
 * таблице файла. У камер телефонов таблицы свои — тогда это «равноценное»
 * качество по шкале libjpeg, его и надо держать при пересжатии.
 */

/** Стандартная таблица яркости JPEG (Annex K); для суммы порядок неважен. */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78,
  87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Сумма таблицы яркости для каждого качества 1…100 (как её строит libjpeg). */
const STD_SUMS: number[] = Array.from({ length: 101 }, (_, q) => {
  if (q === 0) return Number.POSITIVE_INFINITY;
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return STD_LUMA.reduce((s, v) => s + Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))), 0);
});

/** Таблица яркости (id 0) из маркеров DQT; null — не JPEG или таблицы нет. */
export function lumaTable(buf: Uint8Array): number[] | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++; // байт-заполнитель
      continue;
    }
    // Маркеры без длины.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // начались данные — DQT не было
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end) {
        const pq = buf[p]! >> 4;
        const tq = buf[p]! & 0x0f;
        p++;
        const size = pq ? 128 : 64;
        if (p + size > end) return null;
        const table: number[] = [];
        for (let k = 0; k < 64; k++) table.push(pq ? (buf[p + 2 * k]! << 8) | buf[p + 2 * k + 1]! : buf[p + k]!);
        if (tq === 0) return table;
        p += size;
      }
    }
    i += 2 + len;
  }
  return null;
}

/** Качество 1…100 по шкале libjpeg; null — определить не вышло. */
export function estimateJpegQuality(buf: Uint8Array): number | null {
  const table = lumaTable(buf);
  if (!table) return null;
  const sum = table.reduce((s, v) => s + v, 0);
  let best = 1;
  for (let q = 1; q <= 100; q++) {
    // При равенстве — большее качество: не хуже исходника.
    if (Math.abs(STD_SUMS[q]! - sum) <= Math.abs(STD_SUMS[best]! - sum)) best = q;
  }
  return best;
}
