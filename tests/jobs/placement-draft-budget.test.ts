import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { AgentBudgetExceeded } from "@/lib/agents/contract";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import type { StepContext } from "@/lib/jobs/types";
import { placementDraftWorkflow } from "@/lib/jobs/workflows/placement-draft";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * A placement draft's ceiling holds across attempts: a retried job starts
 * from what its earlier attempts already spent (`agent_runs`), not from a
 * fresh $0.75, so one draft cannot cost $1.50.
 */

const BUSINESS = {
  id: "biz-1",
  user_id: "user-1",
  name: "GetTrafficFast",
  niche: "AI SEO content",
  website_url: "https://gettrafficfa.st",
  content_language: "en",
  aeo_settings: {},
  voice_settings: { aboutYou: "I publish my own blog through GetTrafficFast." },
};

const TARGET = {
  id: "t-1",
  business_id: "biz-1",
  user_id: "user-1",
  surface: "reddit",
  kind: "thread",
  community: "r/SEO",
  title: "How do I get my site cited by AI answer engines like ChatGPT and Perplexity?",
  excerpt: "Our SEO is decent but AI answers never mention us. What actually moves the needle?",
  author: "asker",
  status: "qualified",
  qualify_angle: "Answer engines retrieve passages, not pages: every section has to answer its own question in the first two sentences.",
};

function ctx(db: FakeSupabase, attempts: number): StepContext {
  const input = { businessId: "biz-1", targetId: "t-1" };
  return {
    job: {
      id: "job-1",
      user_id: "user-1",
      article_id: null,
      type: "placement-draft",
      input,
      status: "running",
      current_step: null,
      attempts,
      max_attempts: 3,
      last_error: null,
    },
    supabase: db as unknown as SupabaseClient,
    input,
    outputs: {},
    deadline: Date.now() + 120_000,
  };
}

function countingLlm(): LLMProvider & { calls: number } {
  const usage = { model: "stub", inputTokens: 10, outputTokens: 10, costUsd: 0.001 };
  const llm = {
    name: "stub",
    calls: 0,
    async generateText(): Promise<LlmTextResult> {
      llm.calls += 1;
      return { text: "", usage };
    },
    async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      llm.calls += 1;
      return { value: schema.parse({}), usage, raw: "" };
    },
  };
  return llm;
}

describe("placement-draft budget across attempts", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    db = new FakeSupabase({
      businesses: [{ ...BUSINESS }],
      keywords: [{ business_id: "biz-1", keyword: "answer engine optimization" }],
      entities: [],
      placement_targets: [{ ...TARGET }],
      placements: [],
      agent_runs: [],
    });
  });

  afterEach(() => setLlmProvider(null));

  it("refuses to pay for a second attempt once the first spent the whole ceiling", async () => {
    // The first attempt's agents spent $0.75 between them, then the job failed.
    db.tables.agent_runs.push(
      { job_id: "job-1", agent: "placement-draft", cost_usd: 0.5 },
      { job_id: "job-1", agent: "placement-draft", cost_usd: 0.25 },
      // Another job's spend is not this draft's.
      { job_id: "job-2", agent: "placement-draft", cost_usd: 5 }
    );
    const llm = countingLlm();
    setLlmProvider(llm);

    const draft = placementDraftWorkflow.steps.find((s) => s.name === "draft")!;
    await expect(draft.run(ctx(db, 2))).rejects.toBeInstanceOf(AgentBudgetExceeded);
    expect(llm.calls).toBe(0);
  });
});
