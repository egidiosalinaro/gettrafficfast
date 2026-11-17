import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { FakeSupabase } from "../support/fake-supabase";
import { deliveryBody } from "@/lib/publishing/adapters/webhook";
import { SIGNATURE_TOLERANCE_SECONDS, signatureHeaders } from "@/lib/publishing/webhook-signature";

/**
 * This site's receiver and payload v5. The meta title, the FAQ and the
 * modified date are stored in columns a migration adds after the deploy; a
 * database that does not have them yet must still take the post, stored as
 * it was before v5, instead of failing the delivery.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  missingColumns: false,
  missingDeliveries: false,
  upserts: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const builder = m.db.from(table) as unknown as {
        upsert: (values: Record<string, unknown>, options?: unknown) => unknown;
        insert: (values: Record<string, unknown>) => unknown;
      };
      if (table === "blog_webhook_deliveries") {
        // The primary key, as Postgres enforces it, and the default timestamp.
        const insert = builder.insert.bind(builder);
        builder.insert = (values) => {
          if (m.missingDeliveries) {
            return Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
          }
          if (m.db.tables.blog_webhook_deliveries.some((row) => row.delivery_id === values.delivery_id)) {
            return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value" } });
          }
          return insert({ received_at: new Date().toISOString(), ...values });
        };
      }
      const upsert = builder.upsert.bind(builder);
      builder.upsert = (values, options) => {
        m.upserts.push(values);
        if (m.missingColumns && "faq" in values) {
          return Promise.resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'faq' column of 'blog_posts' in the schema cache" } });
        }
        return upsert(values, options);
      };
      return builder;
    },
  }),
}));

import { POST } from "@/app/api/gettrafficfast/route";

const SECRET = "blog-secret";
const payload = {
  event: "article.publish",
  title: "How answer engines pick sources",
  slug: "how-answer-engines-pick-sources",
  html: "<h1>How answer engines pick sources</h1><p>Body.</p>",
  body_html: "<p>Body.</p>",
  keyword: "answer engines",
  scheduled_date: "2026-09-10",
  schema_version: 5,
  article_id: "article-123",
  excerpt: "A short excerpt.",
  seo: { meta_title: "How AI Engines Pick Sources", meta_description: "A meta description." },
  faq: [{ question: "Do they cite blogs?", answer: "Yes." }],
  date_modified: "2026-10-02T06:00:00.000Z",
};

function post(raw: string, headers: Record<string, string>) {
  return POST(new Request("https://gettrafficfa.st/api/gettrafficfast", { method: "POST", headers, body: raw }) as never);
}

/** A delivery as the sender makes it: a fresh delivery id, both signature schemes. */
function deliver(body: unknown, secret = SECRET, nowMs = Date.now()) {
  const raw = deliveryBody(body as Record<string, unknown>);
  return post(raw, signatureHeaders(secret, raw, nowMs));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.BLOG_WEBHOOK_SECRET = SECRET;
  m.db = new FakeSupabase({ blog_posts: [], blog_webhook_deliveries: [] });
  m.missingColumns = false;
  m.missingDeliveries = false;
  m.upserts = [];
});

describe("POST /api/gettrafficfast: the timestamped signature and replays", () => {
  it("refuses a delivery signed only the legacy way, over the body without a timestamp", async () => {
    const raw = deliveryBody(payload);
    const legacy = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
    expect((await post(raw, { "x-signature": legacy })).status).toBe(401);
    expect(m.upserts).toHaveLength(0);
  });

  it("refuses a genuine delivery older than the tolerance, and one from too far ahead", async () => {
    const late = await deliver(payload, SECRET, Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000);
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ error: "Delivery timestamp outside the accepted window" });
    expect((await deliver(payload, SECRET, Date.now() + (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000)).status).toBe(401);
    expect(m.upserts).toHaveLength(0);
  });

  it("refuses a timestamp moved forward on a captured delivery", async () => {
    const raw = deliveryBody(payload);
    const headers = signatureHeaders(SECRET, raw, Date.now() - 3600_000);
    headers["X-GTF-Timestamp"] = String(Math.floor(Date.now() / 1000));
    expect((await post(raw, headers)).status).toBe(401);
  });

  it("answers 409 to the same delivery replayed inside the window, and stores the post once", async () => {
    const raw = deliveryBody(payload);
    const headers = signatureHeaders(SECRET, raw);
    expect((await post(raw, headers)).status).toBe(200);
    const replay = await post(raw, headers);
    expect(replay.status).toBe(409);
    expect(m.upserts).toHaveLength(1);
  });

  it("takes a retry, which is a new request with a new delivery id", async () => {
    expect((await deliver(payload)).status).toBe(200);
    expect((await deliver(payload)).status).toBe(200);
    expect(m.db.tables.blog_posts).toHaveLength(1);
    expect(m.db.tables.blog_webhook_deliveries).toHaveLength(2);
  });

  it("refuses a signed payload with no delivery id", async () => {
    const raw = JSON.stringify(payload);
    expect((await post(raw, signatureHeaders(SECRET, raw))).status).toBe(400);
  });

  it("still takes the delivery, on the timestamp alone, before the deliveries table exists", async () => {
    m.missingDeliveries = true;
    expect((await deliver(payload)).status).toBe(200);
    expect(m.db.tables.blog_posts).toHaveLength(1);
  });
});

describe("POST /api/gettrafficfast with payload v5", () => {
  it("stores the meta title, the FAQ pairs and the modified date", async () => {
    const response = await deliver(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://gettrafficfa.st/blog/how-answer-engines-pick-sources" });
    expect(m.db.tables.blog_posts).toMatchObject([
      {
        gtf_article_id: "article-123",
        meta_title: "How AI Engines Pick Sources",
        faq: [{ question: "Do they cite blogs?", answer: "Yes." }],
        modified_at: "2026-10-02T06:00:00.000Z",
      },
    ]);
  });

  it("still takes the post when the database has no v5 columns yet, stored without them", async () => {
    m.missingColumns = true;
    const response = await deliver(payload);
    expect(response.status).toBe(200);
    expect(m.upserts).toHaveLength(2);
    expect(m.db.tables.blog_posts).toHaveLength(1);
    const stored = m.db.tables.blog_posts[0];
    expect(stored).toMatchObject({ gtf_article_id: "article-123", title: payload.title, body_html: "<p>Body.</p>" });
    for (const column of ["meta_title", "faq", "modified_at"]) expect(stored).not.toHaveProperty(column);
  });

  it("does not retry a failure that is not about those columns", async () => {
    const from = m.db.from.bind(m.db);
    m.db.from = ((table: string) => {
      const builder = from(table) as unknown as { upsert: unknown };
      builder.upsert = () => Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "blog_posts_slug_key"' } });
      return builder;
    }) as never;
    expect((await deliver(payload)).status).toBe(500);
    expect(m.upserts).toHaveLength(1);
  });

  it("refuses a delivery signed with another secret before reading it", async () => {
    expect((await deliver(payload, "someone-else")).status).toBe(401);
    expect(m.upserts).toHaveLength(0);
  });
});
