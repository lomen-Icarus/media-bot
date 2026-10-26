import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { estimateJpegQuality } from "../src/image/jpeg.js";
import { MIN_JPEG_QUALITY, outputName, placement, prepareWatermark, renderWatermarked, watermarkBox } from "../src/image/watermark.js";

/** Фото-заглушка: шум, чтобы JPEG был похож на настоящий. */
async function photo(width: number, height: number, opts: { quality?: number; orientation?: number; format?: "jpeg" | "png"; chroma?: "4:4:4" | "4:2:0" } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 60 + ((i * 7919) % 97);
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.format === "png") return img.png().toBuffer();
  img = img.jpeg({ quality: opts.quality ?? 90, chromaSubsampling: opts.chroma ?? "4:2:0" }).withExif({ IFD0: { Make: "TestCam", Copyright: "Media VISH" } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.toBuffer();
}

/** Красный логотип 300×100 на прозрачном фоне с прозрачными полями. */
async function logo(): Promise<Buffer> {
  const inner = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: 340, height: 140, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inner, left: 20, top: 20 }])
    .png()
    .toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 3;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

describe("качество JPEG", () => {
  it.each([50, 75, 85, 90, 95, 98])("узнаёт качество %i по таблице квантования", async (q) => {
    expect(estimateJpegQuality(await photo(64, 64, { quality: q }))).toBe(q);
  });

  it("не JPEG — null", async () => {
    expect(estimateJpegQuality(await photo(16, 16, { format: "png" }))).toBeNull();
    expect(estimateJpegQuality(Buffer.from("not an image"))).toBeNull();
  });
});

describe("геометрия", () => {
  it("размер: длинная сторона вотермарки — процент от короткой стороны фото", () => {
    expect(watermarkBox(4000, 3000, 300, 100, 20)).toEqual({ width: 600, height: 200 });
    // Вертикальное фото — тот же размер.
    expect(watermarkBox(3000, 4000, 300, 100, 20)).toEqual({ width: 600, height: 200 });
  });

  it("размер не вылезает за фото с отступами", () => {
    const box = watermarkBox(1000, 200, 100, 100, 60);
    expect(box.height).toBeLessThanOrEqual(200 - 2 * 6);
  });

  it("места: углы с отступом 3%, центр без", () => {
    expect(placement(1000, 800, 100, 50, "tl")).toEqual({ left: 24, top: 24 });
    expect(placement(1000, 800, 100, 50, "br")).toEqual({ left: 876, top: 726 });
    expect(placement(1000, 800, 100, 50, "mc")).toEqual({ left: 450, top: 375 });
    expect(placement(1000, 800, 100, 50, "bc")).toEqual({ left: 450, top: 726 });
  });

  it("имя результата", () => {
    expect(outputName("IMG_0001.JPG", "jpeg")).toBe("IMG_0001_wm.JPG");
    expect(outputName("photo.jpeg", "jpeg")).toBe("photo_wm.jpeg");
    expect(outputName("photo_1.jpg", "png")).toBe("photo_1_wm.png");
    expect(outputName("noext", "jpeg")).toBe("noext_wm.jpg");
  });
});

describe("вотермарка на фото", () => {
  it("тот же размер, формат, EXIF; качество не ниже исходника", async () => {
    const src = await photo(1200, 800, { quality: 97, chroma: "4:4:4" });
    const wm = (await prepareWatermark(await logo())).png;
    const out = await renderWatermarked(src, "a.jpg", wm, { position: "br", size: 20, opacity: 100 });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1200, 800, "jpeg"]);
    expect(meta.chromaSubsampling).toBe("4:4:4");
    expect(out.quality).toBe(97);
    expect(estimateJpegQuality(out.bytes)).toBe(97);
    const exif = meta.exif?.toString("latin1") ?? "";
    expect(exif).toContain("TestCam");
    expect(exif).toContain("Media VISH");
  });

  it("низкое качество исходника пересжимается не ниже минимума", async () => {
    const out = await renderWatermarked(await photo(400, 300, { quality: 70 }), "a.jpg", (await prepareWatermark(await logo())).png, { position: "br", size: 20, opacity: 100 });
    expect(out.quality).toBe(MIN_JPEG_QUALITY);
  });

  it("вотермарка там, где выбрали; прозрачные поля логотипа обрезаны", async () => {
    const src = await photo(1000, 1000, { format: "png" });
    const prepared = await prepareWatermark(await logo());
    expect([prepared.width, prepared.height, prepared.hasAlpha]).toEqual([300, 100, true]);
    const out = await renderWatermarked(src, "a.png", prepared.png, { position: "tl", size: 30, opacity: 100 });
    expect(out.name).toBe("a_wm.png");
    // 30% от 1000 = 300×100, отступ 30: в (40, 40) — красный, в правом нижнем углу — фото.
    expect(await pixel(out.bytes, 40, 40)).toEqual([255, 0, 0]);
    expect(await pixel(out.bytes, 329, 129)).toEqual([255, 0, 0]);
    expect((await pixel(out.bytes, 335, 135))[1]).toBeGreaterThan(0);
    expect((await pixel(out.bytes, 960, 960))[1]).toBeGreaterThan(0);
  });

  it("прозрачность смешивает вотермарку с фото", async () => {
    const white = await sharp({ create: { width: 500, height: 500, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const out = await renderWatermarked(white, "w.png", (await prepareWatermark(await logo())).png, { position: "mc", size: 40, opacity: 40 });
    const [r, g] = await pixel(out.bytes, 250, 250);
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(140);
    expect(g).toBeLessThan(165); // 255·0,6 ≈ 153
  });

  it("поворот из EXIF применяется: вотермарка встаёт в угол того фото, что видит человек", async () => {
    // Снято «боком»: в файле 800×400, на экране 400×800.
    const src = await photo(800, 400, { quality: 95, orientation: 6 });
    const out = await renderWatermarked(src, "r.jpg", (await prepareWatermark(await logo())).png, { position: "br", size: 25, opacity: 100 });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([400, 800]);
    expect(meta.orientation ?? 1).toBe(1);
    const [r, g, b] = await pixel(out.bytes, 400 - 12 - 10, 800 - 12 - 10);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it("глубина цвета, альфа-канал и CMYK — как у исходника", async () => {
    const wm = (await prepareWatermark(await logo())).png;
    const s = { position: "br" as const, size: 20, opacity: 100 };
    const base = (channels: 3 | 4) => sharp({ create: { width: 300, height: 200, channels, background: { r: 50, g: 100, b: 150, alpha: 0.5 } } });
    const meta = async (src: Buffer, name: string) => sharp((await renderWatermarked(src, name, wm, s)).bytes).metadata();
    const rgb = await meta(await base(3).png().toBuffer(), "a.png");
    expect([rgb.channels, rgb.depth]).toEqual([3, "uchar"]);
    const rgba = await meta(await base(4).png().toBuffer(), "a.png");
    expect(rgba.channels).toBe(4);
    const deep = await meta(await base(3).toColourspace("rgb16").png().toBuffer(), "a.png");
    expect([deep.channels, deep.depth]).toEqual([3, "ushort"]);
    const cmyk = await meta(await base(3).toColourspace("cmyk").jpeg({ quality: 95 }).toBuffer(), "a.jpg");
    expect(cmyk.space).toBe("cmyk");
  });

  it("не картинка — понятная ошибка", async () => {
    await expect(renderWatermarked(Buffer.from("hello"), "x.jpg", (await prepareWatermark(await logo())).png, { position: "br", size: 20, opacity: 100 })).rejects.toThrow(
      "не открывается как картинка",
    );
  });
});
