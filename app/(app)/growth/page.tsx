import { GrowthScreen } from "@/components/growth/growth-screen";
import { parseGrowthDays } from "@/lib/growth/period";
import type { SearchParams } from "@/lib/growth/routes";

/**
 * Growth: this week against the week before (or 28 days, `?days=28`), in
 * three blocks: Replies on X, Google, AI answers; then the articles behind
 * Google. Results and the numbers of the Overview live here since
 * 2026-11-14 (docs/LIFECYCLE.md, "Growth").
 */
export default async function GrowthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const days = parseGrowthDays((await searchParams).days);
  return <GrowthScreen key={days} days={days} />;
}
