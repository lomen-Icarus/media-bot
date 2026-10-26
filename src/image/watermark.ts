/**
 * Вотермарка на фото без потери качества: размер в пикселях тот же, формат
 * тот же, JPEG пересжимается не ниже качества исходника (и не ниже
 * MIN_JPEG_QUALITY), с той же субдискретизацией цвета; EXIF, ICC-профиль и XMP
 * сохраняются. Поворот из EXIF применяется к пикселям (иначе вотермарка встала
 * бы «боком»), тег поворота сбрасывается.
 */
import sharp, { type Metadata } from "sharp";
import { MARGIN_PCT, type Position, type WatermarkSettings } from "../core/settings.js";
import { estimateJpegQuality } from "./jpeg.js";

/** Ниже не пересжимаем: повторное сжатие с тем же низким качеством добавило бы артефактов. */
export const MIN_JPEG_QUALITY = 92;
/** Длинная сторона вотермарки в базе: хватает на 60% от короткой стороны фото 50 Мп. */
export const WATERMARK_MAX_SIDE = 4000;

/** Ошибка, понятная человеку: текст уходит в бот как есть. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

type OutFormat = "jpeg" | "png" | "webp" | "tiff" | "avif";

const EXT: Record<OutFormat, string[]> = {
  jpeg: ["jpg", "jpeg", "jpe"],
  png: ["png"],
  webp: ["webp"],
  tiff: ["tif", "tiff"],
  avif: ["avif"],
};

export const MIME: Record<OutFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  tiff: "image/tiff",
  avif: "image/avif",
};

/** Расширения, которые бот считает фото, даже если мессенджер не сказал тип. */
export const IMAGE_EXTENSIONS = new Set([...Object.values(EXT).flat(), "heic", "heif"]);

export interface Rendered {
  bytes: Buffer;
  name: string;
  mime: string;
  width: number;
  height: number;
  /** Качество JPEG на выходе (для остальных форматов — null). */
  quality: number | null;
}

/** Имя результата: то же, с «_wm» перед расширением; расширение — как у исходника, если формат тот же. */
export function outputName(original: string, format: OutFormat): string {
  const dot = original.lastIndexOf(".");
  const base = (dot > 0 ? original.slice(0, dot) : original) || "photo";
  const ext = dot > 0 ? original.slice(dot + 1).toLowerCase() : "";
  return `${base}_wm.${EXT[format].includes(ext) ? original.slice(dot + 1) : EXT[format][0]}`;
}

/** Левый верхний угол вотермарки w×h на фото W×H. */
export function placement(W: number, H: number, w: number, h: number, position: Position): { left: number; top: number } {
  const margin = position === "mc" ? 0 : Math.round((Math.min(W, H) * MARGIN_PCT) / 100);
  const col = position[1];
  const row = position[0];
  const left = col === "l" ? margin : col === "r" ? W - w - margin : Math.round((W - w) / 2);
  const top = row === "t" ? margin : row === "b" ? H - h - margin : Math.round((H - h) / 2);
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

/** Размер вотермарки: длинная сторона — size% от короткой стороны фото, и целиком влезает с отступами. */
export function watermarkBox(W: number, H: number, wmW: number, wmH: number, size: number): { width: number; height: number } {
  const short = Math.min(W, H);
  const margin = Math.round((short * MARGIN_PCT) / 100);
  const target = Math.max(1, Math.round((short * size) / 100));
  const k = Math.min(target / Math.max(wmW, wmH), (W - 2 * margin) / wmW, (H - 2 * margin) / wmH);
  return { width: Math.max(1, Math.round(wmW * k)), height: Math.max(1, Math.round(wmH * k)) };
}

async function readMeta(input: Buffer): Promise<Metadata> {
  try {
    return await sharp(input, { failOn: "error" }).metadata();
  } catch {
    throw new ImageError("файл не открывается как картинка");
  }
}

/**
 * Готовит вотермарку для базы: PNG с прозрачностью, поворот из EXIF применён,
 * прозрачные поля по краям обрезаны (иначе отступ от края был бы «плавающим»).
 */
export async function prepareWatermark(input: Buffer): Promise<{ png: Buffer; width: number; height: number; hasAlpha: boolean }> {
  const meta = await readMeta(input);
  if (!meta.width || !meta.height) throw new ImageError("файл не открывается как картинка");
  if (meta.format === "heif" && meta.compression !== "av1") throw new ImageError("HEIC не поддерживается — пришли PNG");
  const hasAlpha = Boolean(meta.hasAlpha);
  let img = sharp(input, { failOn: "error" }).autoOrient().ensureAlpha();
  if (hasAlpha) {
    // trim по цвету угла: у логотипа на прозрачном фоне это прозрачность.
    const trimmed = await img
      .clone()
      .trim({ threshold: 1 })
      .png()
      .toBuffer()
      .catch(() => null);
    if (trimmed) img = sharp(trimmed);
  }
  const png = await img.resize({ width: WATERMARK_MAX_SIDE, height: WATERMARK_MAX_SIDE, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  return { png: png.data, width: png.info.width, height: png.info.height, hasAlpha };
}

/** Вотермарка нужного размера с прозрачностью — сырые RGBA-пиксели. */
async function scaledWatermark(wm: Buffer, width: number, height: number, opacity: number): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(wm).ensureAlpha().resize({ width, height, fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  if (opacity < 100) {
    const k = opacity / 100;
    for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i]! * k);
  }
  return { data, width: info.width, height: info.height };
}

/** Фото + вотермарка → файл того же формата и размера. */
export async function renderWatermarked(input: Buffer, originalName: string, wm: Buffer, settings: WatermarkSettings): Promise<Rendered> {
  const meta = await readMeta(input);
  if (meta.format === "heif" && meta.compression !== "av1") {
    throw new ImageError("HEIC не поддерживается. На iPhone: Настройки → Камера → Форматы → «Наиболее совместимый», или пришли JPG/PNG");
  }
  const format: OutFormat | null =
    meta.format === "jpeg" ? "jpeg" : meta.format === "png" ? "png" : meta.format === "webp" ? "webp" : meta.format === "tiff" ? "tiff" : meta.format === "heif" ? "avif" : null;
  if (!format) throw new ImageError(`формат ${meta.format ?? "?"} не поддерживается — нужен JPG, PNG, WebP, TIFF или AVIF`);
  if ((meta.pages ?? 1) > 1 && format !== "tiff") throw new ImageError("анимация не поддерживается");
  if (!meta.width || !meta.height) throw new ImageError("файл не открывается как картинка");

  // Размеры после поворота из EXIF (5–8 — повёрнуто на 90°).
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;

  const wmMeta = await sharp(wm).metadata();
  const box = watermarkBox(W, H, wmMeta.width ?? 1, wmMeta.height ?? 1, settings.size);
  const mark = await scaledWatermark(wm, box.width, box.height, settings.opacity);
  const { left, top } = placement(W, H, mark.width, mark.height, settings.position);

  let img = sharp(input, { failOn: "error" })
    .autoOrient()
    .composite([{ input: mark.data, raw: { width: mark.width, height: mark.height, channels: 4 }, left, top }])
    .keepMetadata();
  // Глубина и цветовое пространство — как у исходника: иначе libvips отдаст 8 бит sRGB.
  if (meta.depth === "ushort" && (format === "png" || format === "tiff")) img = img.toColourspace(meta.space === "grey16" || meta.space === "b-w" ? "grey16" : "rgb16");
  else if (meta.space === "cmyk" && (format === "jpeg" || format === "tiff")) img = img.toColourspace("cmyk");
  // Наложение добавляет альфа-канал; у исходника без прозрачности его быть не должно.
  if (!meta.hasAlpha) img = img.removeAlpha();

  let quality: number | null = null;
  if (format === "jpeg") {
    quality = Math.max(MIN_JPEG_QUALITY, estimateJpegQuality(input) ?? 0);
    img = img.jpeg({ quality, chromaSubsampling: meta.chromaSubsampling === "4:4:4" ? "4:4:4" : "4:2:0", progressive: Boolean(meta.isProgressive), mozjpeg: false });
  } else if (format === "png") {
    img = img.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (format === "webp") {
    // Без потерь или нет — по метаданным не узнать; 95 — без видимой разницы.
    img = img.webp({ quality: 95, smartSubsample: true });
  } else if (format === "tiff") {
    img = img.tiff({ compression: "lzw" });
  } else {
    img = img.avif({ quality: 90 });
  }
  const out = await img.toBuffer({ resolveWithObject: true });
  return { bytes: out.data, name: outputName(originalName, format), mime: MIME[format], width: out.info.width, height: out.info.height, quality };
}
