import { AiAnswersScreen } from "@/components/growth/ai-answers";
import { parseGrowthDays } from "@/lib/growth/period";
import type { SearchParams } from "@/lib/growth/routes";

/**
 * Growth → AI answers: every answer of the period behind the count, with
 * its sources, so a citation can be checked by eye (docs/AI_VISIBILITY.md,
 * "The evidence"). `?days=28`, `?engine=gemini`. Replaces the Prompts
 * dashboard (`/visibility`, which redirects here).
 */
export default async function AiAnswersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const days = parseGrowthDays(params.days);
  const raw = Array.isArray(params.engine) ? params.engine[0] : params.engine;
  const engine = raw?.trim() ? raw.trim().toLowerCase() : null;
  return <AiAnswersScreen key={`${days}-${engine ?? "all"}`} days={days} engine={engine} />;
}
