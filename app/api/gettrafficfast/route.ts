import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_URL } from "@/lib/site";
import { SEO_COLUMNS, deliveryIdOf, toBlogPostRow, withoutSeoColumns, type WebhookArticlePayload } from "@/lib/blog/receive";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyTimestamped } from "@/lib/publishing/webhook-signature";

/**
 * This site's webhook receiver: the customer half of the Webhooks integration,
 * running on the product's own domain.
 *
 * It is the endpoint documented in docs/NEXTJS_WEBHOOK_RECEIVER.md, implemented
 * here rather than described: gettrafficfa.st is a Next.js site like a
 * customer's, so it receives its articles the same way. That is the point. A
 * private path for the product's own blog would leave the delivery code that
 * every customer depends on as the one part nobody runs daily.
 */

// The signature is computed over the raw body, so nothing may re-encode it.
export const dynamic = "force-dynamic";

/** Seen delivery ids older than this are pruned: the timestamp check already refuses them. */
const DELIVERY_ID_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A missing table, as PostgREST or Postgres say it. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

/**
 * Record the delivery id; false when it was already recorded (a replay).
 * Before the migration that creates the table is applied, the timestamp
 * window is the only replay guard: logged, and the delivery goes on.
 */
async function claimDelivery(admin: ReturnType<typeof createAdminClient>, deliveryId: string): Promise<boolean> {
  const { error } = await admin.from("blog_webhook_deliveries").insert({ delivery_id: deliveryId });
  if (!error) {
    await admin
      .from("blog_webhook_deliveries")
      .delete()
      .lt("received_at", new Date(Date.now() - DELIVERY_ID_RETENTION_MS).toISOString());
    return true;
  }
  if (error.code === "23505") return false;
  if (isMissingTable(error)) {
    console.error("blog receiver: blog_webhook_deliveries is missing; replay check by timestamp only");
    return true;
  }
  throw new Error(error.message);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Only the timestamped signature (v2) is accepted here. The sender still
  // adds the body-only X-Signature for customers' receivers, but on its own
  // it proves nothing about when, so a captured delivery would verify forever.
  const verdict = verifyTimestamped(
    rawBody,
    request.headers.get(SIGNATURE_HEADER),
    request.headers.get(TIMESTAMP_HEADER),
    process.env.BLOG_WEBHOOK_SECRET
  );
  if (!verdict.ok) {
    const error = verdict.reason === "stale" ? "Delivery timestamp outside the accepted window" : "Invalid signature";
    return NextResponse.json({ error }, { status: 401 });
  }

  let payload: WebhookArticlePayload;
  try {
    payload = JSON.parse(rawBody) as WebhookArticlePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const deliveryId = deliveryIdOf(payload);
  if (!deliveryId) {
    return NextResponse.json({ error: "Payload has no delivery_id" }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    if (!(await claimDelivery(admin, deliveryId))) {
      return NextResponse.json({ error: "Delivery already received" }, { status: 409 });
    }
  } catch (err) {
    console.error("blog receiver: could not record the delivery", (err as Error).message);
    return NextResponse.json({ error: "Could not record the delivery" }, { status: 500 });
  }

  // The connection test from Settings → Connections → Webhooks.
  if (payload.event === "test") {
    return NextResponse.json({ ok: true });
  }

  const row = toBlogPostRow(payload);
  if (!row) {
    return NextResponse.json({ error: "Payload has no title or body" }, { status: 422 });
  }

  // Upsert on the stable article id: the cron retries failed publishes and a
  // refresh republishes the same article, so a second delivery must update the
  // post rather than add a twin.
  const updatedAt = new Date().toISOString();
  let { error } = await admin
    .from("blog_posts")
    .upsert({ ...row, updated_at: updatedAt }, { onConflict: "gtf_article_id" });

  // The meta title, FAQ and modified date arrived with payload v5, in
  // columns a later migration adds. A database that does not have them yet
  // must still take the post: stored without them, as before v5.
  if (error && SEO_COLUMNS.some((column) => error?.message?.includes(column))) {
    ({ error } = await admin
      .from("blog_posts")
      .upsert({ ...withoutSeoColumns(row), updated_at: updatedAt }, { onConflict: "gtf_article_id" }));
  }

  if (error) {
    // A slug collision lands here, and it should: two posts sharing a URL is
    // worse than a failed delivery the dashboard shows and retries.
    console.error("blog receiver: could not store the post", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The URL comes back to GetTrafficFast and becomes the article's live URL.
  return NextResponse.json({ url: `${SITE_URL}/blog/${row.slug}` });
}
