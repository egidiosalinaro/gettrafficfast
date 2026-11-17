import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WordPressAdapter } from "@/lib/publishing/adapters/wordpress";
import { encryptSecret } from "@/lib/integrations/crypto";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

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
  const siteUrl = typeof body.siteUrl === "string" ? body.siteUrl.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const applicationPassword =
    typeof body.applicationPassword === "string" ? body.applicationPassword.trim() : "";

  if (!siteUrl || !username || !applicationPassword) {
    return NextResponse.json(
      { error: "siteUrl, username, and applicationPassword are required" },
      { status: 400 }
    );
  }

  let adapter: WordPressAdapter;
  try {
    adapter = new WordPressAdapter({ siteUrl, username, applicationPassword });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid WordPress credentials" },
      { status: 400 }
    );
  }

  try {
    await adapter.testConnection();
  } catch (err) {
    const message = err instanceof Error ? err.message : "WordPress connection failed";
    const cause = err && typeof err === "object" && "cause" in err
      ? (err as { cause?: unknown }).cause
      : undefined;
    console.error("[wp connect] testConnection failed", {
      siteUrl,
      username,
      message,
      cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
  const { data, error } = await supabase
    .from("integrations")
    .upsert(
      {
        user_id: user.id,
        business_id: businessId,
        type: "wordpress",
        status: "connected",
        last_error: null,
        last_sync_at: new Date().toISOString(),
        config: {
          site_url: normalizedSiteUrl,
          username,
          application_password_encrypted: encryptSecret(applicationPassword),
        },
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
