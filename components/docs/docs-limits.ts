import { TOOL_LIMITS } from "@/lib/tools/usage";
import { DAILY_CORRECTION_CAP, DAILY_DRAFT_CAP } from "@/lib/paid-access";
import type { DocsLimits } from "./docs-content";

/**
 * The limits the docs state, read from where the code holds them
 * (lib/tools/usage.ts, lib/paid-access.ts), never retyped: a cap changed
 * there changes the docs on the next deploy. Server only.
 */
export function docsLimits(): DocsLimits {
  return {
    perMinute: TOOL_LIMITS.perMinute,
    daily: [
      ...Object.entries(TOOL_LIMITS.dailyByTool).map(([label, cap]) => ({ label, cap })),
      ...Object.entries(TOOL_LIMITS.dailyByPrefix).map(([prefix, cap]) => ({ label: `each ${prefix}… tool`, cap })),
    ],
    drafts: DAILY_DRAFT_CAP,
    corrections: DAILY_CORRECTION_CAP,
  };
}
