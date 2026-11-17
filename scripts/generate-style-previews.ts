import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { composeImagePrompt } from "../lib/media/prompt";
import {
  DEFAULT_MEDIA_SETTINGS,
  IMAGE_ASPECT_RATIO,
  IMAGE_QUALITY,
} from "../lib/media/settings";
import { PREVIEW_STYLES, STYLE_PREVIEW_SCENE } from "../lib/media/style-previews";
import { getImageProvider } from "../lib/providers/images/registry";

/**
 * Generates the style previews shown in Settings → Generation.
 *
 * Run it whenever a style directive changes:
 *   GEMINI_API_KEY=... npm run previews
 *
 * It goes through the production image path — same scene, same directives,
 * same provider — so the picker cannot advertise a look the generator does not
 * produce. Output lands in public/style-previews/ and is committed: four
 * assets that never change per customer belong in the build, not in a bucket.
 *
 * The render comes back at full size in whatever format the model chose; what
 * is committed is a 640px JPEG, because these are thumbnails and shipping two
 * megabytes of them would be paid for on every settings page view.
 */

const OUT_DIR = path.join(process.cwd(), "public", "style-previews");

/** Displayed at roughly a third of this; enough for retina, not more. */
const PREVIEW_WIDTH = 640;

async function main() {
  const provider = getImageProvider(process.env.IMAGE_PROVIDER || "imagen");
  await mkdir(OUT_DIR, { recursive: true });

  let failures = 0;
  for (const style of PREVIEW_STYLES) {
    const prompt = composeImagePrompt(STYLE_PREVIEW_SCENE, {
      ...DEFAULT_MEDIA_SETTINGS,
      style,
    });
    process.stdout.write(`${style}: rendering… `);
    try {
      const image = await provider.generate({
        prompt,
        aspectRatio: IMAGE_ASPECT_RATIO,
        quality: IMAGE_QUALITY,
      });
      const file = path.join(OUT_DIR, `${style}.jpg`);
      const info = await sharp(image.bytes)
        .resize({ width: PREVIEW_WIDTH })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(file);
      console.log(`ok (${image.model}, ${(info.size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      failures += 1;
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) process.exitCode = 1;
}

main();
