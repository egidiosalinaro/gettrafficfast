import { Workflow } from "./types";
import { PRODUCE_ARTICLE, produceArticleWorkflow } from "./workflows/produce-article";
import { REFRESH_ARTICLE, refreshArticleWorkflow } from "./workflows/refresh-article";
import { AEO_RUN, aeoRunWorkflow } from "./workflows/aeo-run";
import { PLACEMENT_DISCOVERY, placementDiscoveryWorkflow } from "./workflows/placement-discovery";
import { PLACEMENT_DRAFT, placementDraftWorkflow } from "./workflows/placement-draft";
import { searchConsoleIngestWorkflow } from "./workflows/search-console-ingest";
import { BACKLINK_ARTICLE, backlinkArticleWorkflow } from "./workflows/backlink-article";
import { X_DISCOVERY, xDiscoveryWorkflow } from "./workflows/x-discovery";
import { X_CLOSE_TRIAL, xCloseTrialWorkflow } from "./workflows/x-close-trial";
import { PUSH_ARTICLE, pushArticleWorkflow } from "./workflows/push-article";

/**
 * Every workflow the platform can execute. Adding one (research-business,
 * monitor-rankings, …) means registering it here — the worker itself never
 * changes.
 */
const WORKFLOWS: Workflow[] = [
  produceArticleWorkflow,
  refreshArticleWorkflow,
  aeoRunWorkflow,
  placementDiscoveryWorkflow,
  placementDraftWorkflow,
  searchConsoleIngestWorkflow,
  backlinkArticleWorkflow,
  xDiscoveryWorkflow,
  xCloseTrialWorkflow,
  pushArticleWorkflow,
];

const BY_TYPE = new Map(WORKFLOWS.map((w) => [w.type, w]));

export function getWorkflow(type: string): Workflow {
  const workflow = BY_TYPE.get(type);
  if (!workflow) throw new Error(`Unknown job type: ${type}`);
  return workflow;
}

export function workflowTypes(): string[] {
  return [...BY_TYPE.keys()];
}

/**
 * Job types that cannot do their work without a model call. While the LLM
 * layer is paused for billing (`lib/llm-billing.ts`) the worker leaves these
 * queued instead of running them. Discovery is here although its first steps
 * are searches: those searches are paid (Serper) and are only worth paying
 * for when the qualify step can judge what they find. AI Visibility runs
 * (`aeo-run`) and Search Console ingests call no model and keep running.
 * The back-link pass is here because it may ask the model for an anchor
 * (docs/KNOWLEDGE.md): it waits out a pause, the older articles lose nothing.
 * The daily X search is here for the same reason as discovery: its searches
 * are paid, and only worth paying for when the qualifier can judge them;
 * so is the close-accounts trial (`x-close-trial`), the same pipeline.
 * Push page 3 (`push-article`) asks the model for a title and links.
 */
const LLM_BOUND = new Set<string>([PRODUCE_ARTICLE, REFRESH_ARTICLE, PLACEMENT_DISCOVERY, PLACEMENT_DRAFT, BACKLINK_ARTICLE, X_DISCOVERY, X_CLOSE_TRIAL, PUSH_ARTICLE]);

export function isLlmBoundJob(type: string): boolean {
  return LLM_BOUND.has(type);
}

/**
 * Job types that spend money for a customer: the LLM-bound ones, and AI
 * Visibility runs, whose probes are paid answer-engine calls though no model
 * of ours is asked. The worker runs these only for an owner with an active
 * subscription (`hasPaidAccess`): a job queued before the account lapsed is
 * failed, not paid for. Search Console ingests are free and keep running.
 */
const PAID = new Set<string>([...LLM_BOUND, AEO_RUN]);

export function isPaidJob(type: string): boolean {
  return PAID.has(type);
}
