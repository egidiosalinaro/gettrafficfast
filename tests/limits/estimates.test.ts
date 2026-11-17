import { describe, expect, it } from "vitest";
import { aeoAgent } from "@/lib/agents/aeo";
import { draftCorrectAgent } from "@/lib/agents/draft-correct";
import { imageBriefAgent } from "@/lib/agents/image-brief";
import { internalLinksAgent } from "@/lib/agents/internal-links";
import { knowledgeExtractAgent } from "@/lib/agents/knowledge-extract";
import { outlineAgent } from "@/lib/agents/outline";
import { placementDraftAgent } from "@/lib/agents/placement-draft";
import { placementQualifyAgent } from "@/lib/agents/placement-qualify";
import { proposePromptsAgent } from "@/lib/agents/propose-prompts";
import { refreshPlanAgent } from "@/lib/agents/refresh-plan";
import { refreshWriteAgent } from "@/lib/agents/refresh-write";
import { serpAnalysisAgent } from "@/lib/agents/serp-analysis";
import { videoSelectAgent } from "@/lib/agents/video-select";
import { writingAgent } from "@/lib/agents/writing";
import { UNMEASURED_RUN_ESTIMATES } from "@/lib/limits/estimates";

/**
 * Every agent has a figure for a run whose cost was not recorded
 * (lib/limits/estimates.ts), cheaper on a Flash or Haiku model and never 0.
 * A new agent without one would count at the dearest figure: safe, but the
 * table should say what it costs.
 */

const AGENTS = [
  aeoAgent,
  draftCorrectAgent,
  imageBriefAgent,
  internalLinksAgent,
  knowledgeExtractAgent,
  outlineAgent,
  placementDraftAgent,
  placementQualifyAgent,
  proposePromptsAgent,
  refreshPlanAgent,
  refreshWriteAgent,
  serpAnalysisAgent,
  videoSelectAgent,
  writingAgent,
];

describe("the estimate table", () => {
  it("has a figure for every agent, above zero, dearer when the model is not a cheap one", () => {
    for (const agent of AGENTS) {
      const estimate = UNMEASURED_RUN_ESTIMATES[agent.name];
      expect(estimate, `${agent.name} has no estimate`).toBeDefined();
      expect(estimate.fast).toBeGreaterThan(0);
      expect(estimate.quality).toBeGreaterThanOrEqual(estimate.fast);
    }
  });
});
