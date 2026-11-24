import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { AutomationSettings, parseAutomationSettings } from "@/lib/automation/settings";
import { saveAutomationSettings } from "@/lib/business/save-settings";
import { describeAutopilotRun, readAutopilotRun } from "@/lib/automation/run-status";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);

  if (!businessId) {
    return NextResponse.json({
      hasBusiness: false,
      settings: parseAutomationSettings(null),
      siteName: null,
      autopilotRun: null,
      availableKeywords: 0,
      scheduledArticles: 0,
    });
  }

  const { data: business } = await supabase
    .from("businesses")
    .select("id, name, automation_settings")
    .eq("id", businessId)
    .eq("user_id", user.id)
    .maybeSingle();

  // What the customer needs to judge the setting: how much fuel is left, for
  // THIS site. Counting across the account would tell them a number about a
  // calendar they are not looking at.
  const { count: availableKeywords } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .is("article_id", null)
    .eq("status", "available");

  const { count: scheduledArticles } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("scheduled_date", new Date().toISOString().slice(0, 10));

  // Which site this page sets, by name: an account with several sites has
  // one Autopilot setting per site. And what its last run did, and why it
  // did less when it did (lib/automation/run-status.ts).
  const settings = parseAutomationSettings(business?.automation_settings);
  const autopilotRun = business
    ? describeAutopilotRun({ enabled: settings.enabled, run: await readAutopilotRun(supabase, businessId) })
    : null;

  return NextResponse.json({
    hasBusiness: Boolean(business),
    settings,
    siteName: (business?.name as string | null | undefined) ?? null,
    autopilotRun,
    availableKeywords: availableKeywords ?? 0,
    scheduledArticles: scheduledArticles ?? 0,
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  // Strict on write, tolerant on read: this is our own form, so an invalid
  // value is a bug worth surfacing rather than something to paper over.
  const parsed = AutomationSettings.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  // The same function the update_automation_settings tool calls
  // (lib/business/save-settings.ts).
  const saved = await saveAutomationSettings({ supabase, userId: user.id, businessId, settings: parsed.data });
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
  return NextResponse.json({ settings: saved.settings });
}
