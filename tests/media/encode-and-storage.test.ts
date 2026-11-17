import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_IMAGE_WIDTH, encodeForWeb } from "@/lib/media/encode";
import { MEDIA_BUCKET, storeImage } from "@/lib/media/storage";

/**
 * What is stored for a generated image: at most 1600 px wide, WebP, with its
 * measured size on the ledger row and on what the caller gets back. The
 * encoder is the real one, on small solid-colour buffers.
 */

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

function isWebp(bytes: Uint8Array): boolean {
  const text = (from: number, to: number) => Buffer.from(bytes.slice(from, to)).toString("ascii");
  return text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
}

describe("encodeForWeb", () => {
  it("resizes a wide render to 1600 px and encodes WebP, keeping the ratio", async () => {
    const encoded = await encodeForWeb(await jpeg(2400, 1350));
    expect(encoded.mimeType).toBe("image/webp");
    expect(isWebp(encoded.bytes)).toBe(true);
    expect(encoded.width).toBe(MAX_IMAGE_WIDTH);
    expect(encoded.height).toBe(900);

    // The dimensions reported are the ones of the bytes produced.
    const meta = await sharp(encoded.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 1600, 900]);
  });

  it("does not enlarge an image that is already narrower", async () => {
    const encoded = await encodeForWeb(await jpeg(64, 36));
    expect([encoded.width, encoded.height]).toEqual([64, 36]);
    expect(isWebp(encoded.bytes)).toBe(true);
  });

  it("refuses bytes that are not an image", async () => {
    await expect(encodeForWeb(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

interface Upload {
  bucket: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

function fakeSupabase(options: { rejectSizeColumns?: boolean } = {}) {
  const uploads: Upload[] = [];
  const rows: Record<string, unknown>[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => {
          uploads.push({ bucket, path, bytes, contentType: opts.contentType });
          return { error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example.com/${path}` } }),
      }),
    },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        if (options.rejectSizeColumns && "width" in row) {
          return { error: { message: "Could not find the 'width' column of 'media_assets' in the schema cache" } };
        }
        rows.push(row);
        return { error: null };
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, uploads, rows };
}

const base = {
  userId: "user-1",
  businessId: "biz-1",
  articleId: "article-1",
  provider: "imagen",
  model: "some-image-model",
  prompt: "A baker at an oven",
  costUsd: 0.039,
};

describe("storeImage", () => {
  it("stores the encoded WebP and records its width, height and bytes", async () => {
    const db = fakeSupabase();
    const source = await jpeg(2400, 1350);

    const stored = await storeImage({
      ...base,
      supabase: db.client,
      kind: "hero",
      bytes: source,
      mimeType: "image/jpeg",
    });

    expect(db.uploads).toHaveLength(1);
    const upload = db.uploads[0];
    expect(upload.bucket).toBe(MEDIA_BUCKET);
    expect(upload.path).toBe("user-1/article-1/hero.webp");
    expect(upload.contentType).toBe("image/webp");
    expect(isWebp(upload.bytes)).toBe(true);

    expect(stored).toMatchObject({
      url: "https://storage.example.com/user-1/article-1/hero.webp",
      width: 1600,
      height: 900,
      mimeType: "image/webp",
      bytes: upload.bytes.byteLength,
    });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      kind: "hero",
      width: 1600,
      height: 900,
      bytes: upload.bytes.byteLength,
      storage_path: "user-1/article-1/hero.webp",
    });
    expect(db.rows[0].meta).toMatchObject({
      mime_type: "image/webp",
      cost_usd: 0.039,
      source_mime_type: "image/jpeg",
      source_bytes: source.byteLength,
    });
  });

  it("names inline images by their position", async () => {
    const db = fakeSupabase();
    await storeImage({
      ...base,
      supabase: db.client,
      kind: "inline",
      index: 2,
      bytes: await jpeg(320, 180),
      mimeType: "image/jpeg",
    });
    expect(db.uploads[0].path).toBe("user-1/article-1/inline-2.webp");
  });

  it("still records the render's cost when the size columns are not there yet", async () => {
    const db = fakeSupabase({ rejectSizeColumns: true });
    await storeImage({
      ...base,
      supabase: db.client,
      kind: "hero",
      bytes: await jpeg(320, 180),
      mimeType: "image/jpeg",
    });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).not.toHaveProperty("width");
    expect(db.rows[0].meta).toMatchObject({ cost_usd: 0.039, width: 320, height: 180 });
  });

  it("stores the original, with unknown dimensions, when the bytes cannot be encoded", async () => {
    const db = fakeSupabase();
    const garbage = new Uint8Array([9, 9, 9, 9, 9]);
    const stored = await storeImage({
      ...base,
      supabase: db.client,
      kind: "hero",
      bytes: garbage,
      mimeType: "image/png",
    });
    expect(db.uploads[0].path).toBe("user-1/article-1/hero.png");
    expect(db.uploads[0].bytes).toBe(garbage);
    // Not measured is null, never a guessed 16:9.
    expect(stored.width).toBeNull();
    expect(stored.height).toBeNull();
    expect(db.rows[0]).toMatchObject({ width: null, height: null, bytes: 5 });
  });
});
