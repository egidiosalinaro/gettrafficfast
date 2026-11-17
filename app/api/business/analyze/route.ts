import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { recordScreenAction } from "@/lib/limits/actions";
import { analyzeSite } from "@/lib/research/analyze-site";
import { DEFAULT_CONTENT_LANGUAGE, isContentLanguage } from "@/lib/content-language";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = await requirePaidAccess(user);
    if (denied) return denied;
    // The account's daily AI spend limit and its daily cap on analyses,
    // counted with the API's (lib/limits/guard.ts).
    const limited = await requireAccountCapacity(createAdminClient, user.id, "analyze_website");
    if (limited) return limited;
    const startedAt = new Date();

    const body = await request.json();
    const contentLanguage = isContentLanguage(body.contentLanguage)
      ? body.contentLanguage
      : DEFAULT_CONTENT_LANGUAGE;

    // The same function the analyze_website tool calls
    // (lib/research/analyze-site.ts). Every model account refusing to pay
    // comes back as a 503 in words, already recorded (pause, one alert).
    const result = await analyzeSite({
      admin: createAdminClient,
      websiteUrl: body.websiteUrl,
      contentLanguage,
      source: "api.business.analyze",
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    recordScreenAction(createAdminClient, {
      userId: user.id,
      businessId: null,
      tool: "analyze_website",
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
    });
    return NextResponse.json(result.analysis);
  } catch (error) {
    console.error("Error in analyze endpoint:", error);

    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message || "Failed to analyze website" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
