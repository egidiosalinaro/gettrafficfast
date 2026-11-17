import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listAiAnswers, loadAskSetup } from "@/lib/growth/read";
import { parseGrowthDays } from "@/lib/growth/period";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Growth → AI answers (`/growth/ai`): the period's answers, newest first
 * (`listAiAnswers`, the function `list_ai_answers` calls), and what the
 * screen needs under them (the question set, the engines, the latest run).
 * `?days=28`, `?engine=gemini`, `?offset=20`.
 *
 * Through the user's own session, so RLS is the access control. Stored rows
 * only: nothing here asks an engine.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ hasBusiness: false });

    const params = new URL(request.url).searchParams;
    const offset = Number.parseInt(params.get("offset") ?? "0", 10);
    const [answers, setup] = await Promise.all([
      listAiAnswers(supabase, businessId, {
        days: parseGrowthDays(params.get("days")),
        engine: params.get("engine"),
        offset: Number.isFinite(offset) ? offset : 0,
      }),
      loadAskSetup(supabase, businessId),
    ]);
    return NextResponse.json({ hasBusiness: true, answers, setup });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
