import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WebhookAdapter } from "@/lib/publishing/adapters/webhook";
import { encryptSecret } from "@/lib/integrations/crypto";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { isOwnWebhookReceiver, ownWebhookUrl } from "@/lib/site";
import { isOwnBlogOwner } from "@/lib/publishing/own-blog";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const ownReceiver = url ? isOwnWebhookReceiver(url) : false;

  // The own receiver is signed with BLOG_WEBHOOK_SECRET, which no customer
  // knows; connecting it would let any account publish into the public blog.
  // Only an operator named in OWN_BLOG_OWNER_USER_IDS may, and the check fails
  // closed when the variable is unset.
  if (ownReceiver && !isOwnBlogOwner(user.id)) {
    return NextResponse.json(
      { error: "That address is reserved. Enter the webhook URL of your own site." },
      { status: 403 }
    );
  }
  const secret = ownReceiver
    ? (process.env.BLOG_WEBHOOK_SECRET ?? "")
    : typeof body.secret === "string"
      ? body.secret.trim()
      : "";

  if (!url || !secret) {
    return NextResponse.json(
      {
        error: ownReceiver
          ? "BLOG_WEBHOOK_SECRET is not set on this deployment"
          : "url and secret are required",
      },
      { status: 400 }
    );
  }

  let adapter: WebhookAdapter;
  try {
    adapter = new WebhookAdapter({ url, secret });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid webhook configuration" },
      { status: 400 }
    );
  }

  try {
    await adapter.testConnection();
  } catch (err) {
    // The detailed reason (refused, timed out, blocked address, status code)
    // stays in the server log. Echoing it would turn this form into a port
    // scanner: "connection refused" and "timeout" describe someone's network.
    const message = err instanceof Error ? err.message : "Webhook test failed";
    console.error("[webhook connect] testConnection failed", { url, message });
    return NextResponse.json(
      {
        error:
          "Could not reach that address. Check the URL is public, the endpoint accepts a signed POST, and the secret matches.",
      },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("integrations")
    .upsert(
      {
        user_id: user.id,
        business_id: businessId,
        type: "webhook",
        status: "connected",
        last_error: null,
        last_sync_at: new Date().toISOString(),
        config: ownReceiver
          ? // No secret stored: the resolver signs the own receiver with the
            // env secret because of the URL and the owner, never a flag here.
            { url: ownWebhookUrl() }
          : { url, secret_encrypted: encryptSecret(secret) },
      },
      { onConflict: "business_id,type" }
    )
    .select("id, type, status, last_sync_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, integration: data });
}
