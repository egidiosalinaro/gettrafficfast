import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { runJob } from "@/lib/jobs/worker";
import type { JobRow, Workflow } from "@/lib/jobs/types";
import { armOf, produceArticleWorkflow } from "@/lib/jobs/workflows/produce-article";
import { llmChain, setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { setSerpProvider } from "@/lib/providers/serp/registry";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * One arm per job. The `arm` step of article production asks the registry
 * once and the worker checkpoints the answer like any step output, so a job
 * that is retried, held, or resumed after midnight UTC reads the same arm
 * back; every agent of the job is then given it.
 */

const seen = vi.hoisted(() => ({ asked: [] as Array<[string | undefined, string | null | undefined]> }));
vi.mock("@/lib/providers/llm/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/providers/llm/registry")>();
  return {
    ...original,
    getLlmProvider: (role?: "writer", arm?: string | null) => {
      seen.asked.push([role, arm]);
      return original.getLlmProvider(role, arm);
    },
  };
});

vi.mock("@/lib/jobs/registry", () => ({
  getWorkflow: () => (globalThis as { __armWorkflow?: Workflow }).__armWorkflow,
  isLlmBoundJob: () => false,
  isPaidJob: () => false,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

const ARM_STEP = produceArticleWorkflow.steps[0];

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "arm-flow",
    input: { articleId: "article-1" },
    status: "running",
    current_step: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    ...overrides,
  };
}

/** The real `arm` step, then a step that reports the arm it was handed and fails while `failing` says so. */
function flow(state: { failing: boolean; armsSeen: (string | null)[] }) {
  (globalThis as { __armWorkflow?: Workflow }).__armWorkflow = {
    type: "arm-flow",
    steps: [
      ARM_STEP,
      {
        name: "work",
        async run(ctx) {
          state.armsSeen.push(armOf(ctx.outputs));
          if (state.failing) throw new Error("the provider did not answer");
          return { arm: armOf(ctx.outputs) };
        },
      },
    ],
  };
}

const deadline = () => Date.now() + 60_000;

beforeEach(() => {
  seen.asked.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("LLM_FALLBACK", "");
  vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
  vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setLlmProvider(null);
  setSerpProvider(undefined);
});

describe("the arm of a production job", () => {
  it("is the first step, makes no call, and stores the provider of the UTC day", async () => {
    expect(ARM_STEP.name).toBe("arm");
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    const db = new FakeSupabase({ jobs: [job() as unknown as Record<string, unknown>] });
    const state = { failing: false, armsSeen: [] as (string | null)[] };
    flow(state);

    expect(await runJob(db as unknown as SupabaseClient, job(), deadline())).toBe("completed");

    expect(db.step("job-1", "arm")).toMatchObject({
      status: "completed",
      output: { arm: "anthropic", day: "2026-11-10", rotation: ["gemini", "anthropic"] },
    });
    expect(state.armsSeen).toEqual(["anthropic"]);
    // The finished job carries its arm with its other outputs.
    expect((db.job("job-1")?.result as Record<string, unknown>).arm).toMatchObject({ arm: "anthropic" });
    expect(db.tables.agent_runs ?? []).toEqual([]);
  });

  it("keeps its arm when a retry lands after midnight UTC, while a job that starts then gets the new day's", async () => {
    // 23:50 on a Claude day: the arm is chosen, the work fails.
    vi.setSystemTime(new Date("2026-11-10T23:50:00Z"));
    const db = new FakeSupabase({
      jobs: [job(), job({ id: "job-2" })] as unknown as Record<string, unknown>[],
    });
    const state = { failing: true, armsSeen: [] as (string | null)[] };
    flow(state);

    expect(await runJob(db as unknown as SupabaseClient, job(), deadline())).toBe("retrying");
    expect(db.step("job-1", "arm")?.output).toMatchObject({ arm: "anthropic", day: "2026-11-10" });

    // 00:10 the next day, a Gemini day: the retry reads the stored arm back.
    vi.setSystemTime(new Date("2026-11-11T00:10:00Z"));
    state.failing = false;
    expect(await runJob(db as unknown as SupabaseClient, job({ attempts: 2 }), deadline())).toBe("completed");

    expect(state.armsSeen).toEqual(["anthropic", "anthropic"]);
    expect(db.step("job-1", "arm")?.output).toMatchObject({ arm: "anthropic", day: "2026-11-10" });
    expect(db.step("job-1", "work")?.output).toEqual({ arm: "anthropic" });
    expect(llmChain("writer", armOf({ arm: db.step("job-1", "arm")?.output }))).toEqual(["anthropic", "gemini"]);

    // A different job, first run at 00:10: the new day's arm.
    expect(await runJob(db as unknown as SupabaseClient, job({ id: "job-2" }), deadline())).toBe("completed");
    expect(db.step("job-2", "arm")?.output).toMatchObject({ arm: "gemini", day: "2026-11-11" });
    expect(db.step("job-2", "work")?.output).toEqual({ arm: "gemini" });
  });

  it("keeps its arm when the drafting checkpoints are thrown away for a rewrite", async () => {
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    const db = new FakeSupabase({ jobs: [job() as unknown as Record<string, unknown>] });
    flow({ failing: false, armsSeen: [] });
    await runJob(db as unknown as SupabaseClient, job(), deadline());

    // What `validate` does when a draft is unusable.
    await (db as unknown as SupabaseClient).from("job_steps").delete().eq("job_id", "job-1").in("step", ["outline", "write"]);

    expect(db.step("job-1", "arm")?.output).toMatchObject({ arm: "anthropic" });
  });

  it("stores no arm when there is no rotation, and none for a job already under way", async () => {
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    const run = (outputs: Record<string, unknown>) =>
      ARM_STEP.run({ job: job(), supabase: new FakeSupabase() as unknown as SupabaseClient, input: {}, outputs });

    // Started before the step existed: research is already checkpointed.
    expect(await run({ research: { skipped: "no SERP provider configured" } })).toEqual({ arm: null });

    vi.stubEnv("LLM_ARTICLE_ROTATION", "");
    expect(await run({})).toEqual({ arm: null });
    expect(armOf({ arm: { arm: null } })).toBeNull();
    expect(armOf({})).toBeNull();
  });

  it("stops with the variable named when the rotation holds an unknown provider", async () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,gpt");
    await expect(
      ARM_STEP.run({ job: job(), supabase: new FakeSupabase() as unknown as SupabaseClient, input: {}, outputs: {} })
    ).rejects.toThrow(/LLM_ARTICLE_ROTATION: "gpt"/);
  });
});

describe("the agents of a job on an arm", () => {
  const OUTLINE = {
    title: "How to build a content calendar",
    angle: "A calendar a small team keeps",
    intro: "Open with the week nobody knew what to publish.",
    sections: ["What goes in it", "How to fill it", "How to keep it"].map((heading) => ({
      heading,
      question: `${heading}?`,
      answer: "A direct answer.",
      points: ["One"],
      subsections: [],
    })),
    faq: [],
    entities: [],
  };

  function stubModel() {
    const usage = { model: "stub-model", inputTokens: 100, outputTokens: 100, costUsd: 0.001, provider: "anthropic", fallback: false };
    const llm: LLMProvider = {
      name: "stub",
      async generateText(): Promise<LlmTextResult> {
        return { text: "<h1>Title</h1><p>Body.</p>", usage };
      },
      async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
        return { value: schema.parse(OUTLINE), usage, raw: "" };
      },
    };
    setLlmProvider(llm);
  }

  function seed() {
    return new FakeSupabase({
      articles: [
        {
          id: "article-1",
          user_id: "user-1",
          business_id: "biz-1",
          keyword_id: "kw-1",
          scheduled_date: "2026-11-12",
          status: "queued",
          attempt_count: 0,
          last_error: null,
          keywords: { keyword: "content calendar" },
        },
      ],
      businesses: [
        {
          id: "biz-1",
          name: "GetTrafficFast",
          niche: "Content platform",
          description: "Plans and writes articles.",
          website_url: "https://gettrafficfa.st",
          content_language: "en",
          media_settings: null,
          voice_settings: { aboutYou: "We publish for 14 sites.", instructions: "" },
        },
      ],
      article_events: [],
    });
  }

  async function produce(db: FakeSupabase, names: string[]) {
    const outputs: Record<string, unknown> = {};
    const row = { ...job(), type: "produce-article" };
    for (const name of names) {
      const step = produceArticleWorkflow.steps.find((s) => s.name === name)!;
      outputs[name] = (await step.run({ job: row, supabase: db as unknown as SupabaseClient, input: row.input, outputs })) ?? null;
    }
    return outputs;
  }

  it("hands the stored arm to every agent, the writer included, and records who answered", async () => {
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    vi.stubEnv("SERPER_API_KEY", "");
    stubModel();
    const db = seed();

    const outputs = await produce(db, ["arm", "outline", "write"]);

    expect(armOf(outputs)).toBe("anthropic");
    // The outline has no role and the writer has one: both were given the arm.
    expect(seen.asked).toEqual([
      [undefined, "anthropic"],
      ["writer", "anthropic"],
    ]);
    expect(db.tables.agent_runs.map((run) => [run.agent, run.status, run.llm_calls])).toEqual([
      [
        "outline",
        "completed",
        [{ provider: "anthropic", model: "stub-model", fallback: false, tierDowngraded: false, inputTokens: 100, outputTokens: 100, costUsd: 0.001 }],
      ],
      [
        "writing",
        "completed",
        [{ provider: "anthropic", model: "stub-model", fallback: false, tierDowngraded: false, inputTokens: 100, outputTokens: 100, costUsd: 0.001 }],
      ],
    ]);
  });

  it("gives the agents no arm when the rotation is unset: the writer keeps its own variable", async () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "");
    stubModel();
    const db = seed();

    const outputs = await produce(db, ["arm", "outline", "write"]);

    expect(outputs.arm).toEqual({ arm: null });
    expect(seen.asked).toEqual([
      [undefined, null],
      ["writer", null],
    ]);
    expect(llmChain("writer", null)).toEqual(["anthropic", "gemini"]);
    expect(llmChain(undefined, null)).toEqual(["gemini"]);
  });
});
