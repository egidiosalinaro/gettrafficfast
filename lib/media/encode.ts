import sharp from "sharp";

/**
 * What every generated image goes through before it is stored: at most
 * 1600 px wide, WebP, quality 80.
 *
 * The providers answer with a full-size JPEG or PNG: 771 KB on average in
 * production (2026-11-10), three megabytes for an article with four images,
 * served to a text column that is never wider than 1600 px on any screen.
 * The dimensions are measured here, from the encoded bytes, because they are
 * what the `<img>` has to declare for the page not to jump while it loads.
 *
 * An image that is already narrower is not enlarged: upscaling adds bytes
 * and no detail.
 */

export const MAX_IMAGE_WIDTH = 1600;
export const WEBP_QUALITY = 80;

export interface EncodedImage {
  bytes: Uint8Array;
  mimeType: "image/webp";
  width: number;
  height: number;
}

export async function encodeForWeb(source: Uint8Array): Promise<EncodedImage> {
  const { data, info } = await sharp(source)
    .rotate() // apply EXIF orientation before it is stripped with the metadata
    .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    mimeType: "image/webp",
    width: info.width,
    height: info.height,
  };
}
