import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import {
  LlmError,
  isLlmBillingRefusal,
  type LLMProvider,
  type LlmStructuredResult,
} from "@/lib/providers/llm/types";
import { StepIncomplete, type StepContext } from "@/lib/jobs/types";
import {
  BATCH_COST_ESTIMATE_USD,
  QUALIFY_CONCURRENCY,
  placementDiscoveryWorkflow,
  qualifyAdmission,
} from "@/lib/jobs/workflows/placement-discovery";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The qualify step judges its batches QUALIFY_CONCURRENCY at a time since
 * 2026-11-12 (a run spent six minutes judging twelve batches one after the
 * other). Same prompt, same batches, same budget, and the rows end exactly
 * as the sequential loop left them.
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

function seed(n: number): FakeSupabase {
  const targets = Array.from({ length: n }, (_, i) => ({
    id: `t-${String(i).padStart(3, "0")}`,
    business_id: "biz-1",
    user_id: "user-1",
    surface: "reddit",
    kind: "thread",
    url: `https://www.reddit.com/r/SEO/comments/p${i}/x/`,
    title: `How do I get cited by AI answer engines? number ${i}`,
    excerpt: "Our ai seo is fine, answer engines ignore us.",
    community: "r/SEO",
    posted_at: null,
    score: null,
    comment_count: null,
    found_for: "ai seo",
    found_via: "web-search",
    status: "discovered",
    created_at: "2026-11-11",
    // Distinct, so the pool's order (most recently seen first) is fixed.
    last_seen_at: new Date(
      Date.parse("2026-11-11T12:00:00Z") - i * 60_000,
    ).toISOString(),
  }));
  return new FakeSupabase({
    businesses: [{ ...BUSINESS }],
    keywords: [
      { business_id: "biz-1", keyword: "ai seo", created_at: "2026-09-01" },
    ],
    entities: [],
    placement_targets: targets,
    agent_runs: [],
    jobs: [{ id: "job-1", status: "running", result: null }],
  });
}

function ctx(db: FakeSupabase, deadlineMs = 120_000): StepContext {
  const input = { businessId: "biz-1" };
  return {
    job: {
      id: "job-1",
      user_id: "user-1",
      article_id: null,
      type: "placement-discovery",
      input,
      status: "running",
      current_step: "qualify",
      attempts: 1,
      max_attempts: 3,
      last_error: null,
    },
    supabase: db as unknown as SupabaseClient,
    input,
    outputs: {},
    deadline: Date.now() + deadlineMs,
  };
}

const qualify = () =>
  placementDiscoveryWorkflow.steps.find((s) => s.name === "qualify")!;
const usage = {
  model: "stub",
  inputTokens: 10,
  outputTokens: 10,
  costUsd: 0.001,
};

/** Threads in the prompt, by their title's number: the verdict depends on the thread only. */
function numbersIn(prompt: string): number[] {
  return [...prompt.matchAll(/number (\d+)/g)].map((m) => Number(m[1]));
}

function judge(
  options: {
    delay?: (call: number) => number;
    onCall?: (call: number, numbers: number[]) => void;
    fail?: (call: number) => Error | null;
    /** One call at a time: each waits for the one before it to end, as the sequential loop did. */
    serial?: boolean;
  } = {},
) {
  let calls = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  const stats = { most: 0, calls: () => calls };
  const provider: LLMProvider = {
    name: "stub",
    async generateText() {
      return { text: "", usage };
    },
    async generateStructured<T>(
      prompt: string,
      schema: z.ZodType<T>,
    ): Promise<LlmStructuredResult<T>> {
      const call = calls++;
      if (options.serial) {
        const before = chain;
        let release!: () => void;
        chain = new Promise<void>((resolve) => (release = resolve));
        await before;
        try {
          return await answer(call, prompt, schema);
        } finally {
          release();
        }
      }
      return answer(call, prompt, schema);
    },
  };
  async function answer<T>(
    call: number,
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<LlmStructuredResult<T>> {
    inFlight += 1;
    stats.most = Math.max(stats.most, inFlight);
    const numbers = numbersIn(prompt);
    options.onCall?.(call, numbers);
    try {
      await new Promise((resolve) =>
        setTimeout(resolve, options.delay?.(call) ?? 0),
      );
      const failure = options.fail?.(call);
      if (failure) throw failure;
      const verdicts = numbers.map((n, index) =>
        n % 3 === 0
          ? {
              index,
              verdict: "qualified",
              score: 50 + n,
              reason: "On topic.",
              angle: "Passages answer their own question first.",
              topic: "AI citations",
              intent: "question",
            }
          : {
              index,
              verdict: "rejected",
              score: 10,
              reason: "Not it.",
              angle: null,
              topic: null,
              intent: null,
            },
      );
      return { value: schema.parse({ verdicts }), usage, raw: "" };
    } finally {
      inFlight -= 1;
    }
  }
  return { provider, stats };
}

const snapshot = (db: FakeSupabase) =>
  db.tables.placement_targets
    .map((t) => ({
      id: t.id,
      status: t.status,
      score: t.qualify_score,
      by: t.qualified_by,
      angle: t.qualify_angle,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

describe("qualify in parallel", () => {
  afterEach(() => setLlmProvider(null));

  it("leaves the rows exactly as the sequential loop does, whatever order the batches end in", async () => {
    // Reference: one batch at a time, each call ending before the next one runs.
    const sequentialDb = seed(60);
    const sequential = judge({ serial: true, delay: () => 2 });
    setLlmProvider(sequential.provider);
    const outA = await qualify().run(ctx(sequentialDb));
    expect(sequential.stats.most).toBe(1);

    // The same rows, later batches answering first.
    const parallelDb = seed(60);
    const parallel = judge({ delay: (call) => (10 - call) * 4 });
    setLlmProvider(parallel.provider);
    const outB = await qualify().run(ctx(parallelDb));

    expect(outB).toEqual(outA);
    expect(outA).toMatchObject({ judged: 60 });
    expect((outA as { qualified: number }).qualified).toBeGreaterThan(0);
    expect(snapshot(parallelDb)).toEqual(snapshot(sequentialDb));
    expect(parallel.stats.most).toBeGreaterThan(1);
  });

  it("never has more than QUALIFY_CONCURRENCY batches in flight, and shows its progress on the job", async () => {
    const db = seed(120);
    const { provider, stats } = judge({ delay: () => 5 });
    setLlmProvider(provider);
    await qualify().run(ctx(db));
    expect(QUALIFY_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(QUALIFY_CONCURRENCY).toBeLessThanOrEqual(6);
    expect(stats.most).toBe(QUALIFY_CONCURRENCY);
    expect(stats.calls()).toBe(12);
    expect(db.tables.jobs[0].result).toEqual({
      progress: { step: "qualify", judged: 120, total: 120 },
    });
  });

  it("stops starting batches on a billing refusal, writes what finished beside it, and hands the refusal to the worker", async () => {
    const db = seed(100);
    const started: number[] = [];
    const { provider } = judge({
      delay: (call) => (call === 1 ? 1 : 15),
      onCall: (call) => started.push(call),
      fail: (call) =>
        call === 1
          ? new LlmError("Gemini credits are depleted.", "gemini", undefined, {
              retryable: false,
              report: false,
              billingRefused: ["gemini"],
            })
          : null,
    });
    setLlmProvider(provider);

    const error = await qualify()
      .run(ctx(db))
      .catch((err) => err);
    // The worker pauses the layer on exactly this (lib/jobs/worker.ts).
    expect(isLlmBillingRefusal(error)).toBe(true);
    // Only the first wave started: nothing after the refusal.
    expect(started.length).toBe(QUALIFY_CONCURRENCY);
    // The batches beside it were paid for and are written; the refused one stays discovered.
    const judged = db.tables.placement_targets.filter(
      (t) => t.qualified_by === "agent",
    );
    expect(judged).toHaveLength((QUALIFY_CONCURRENCY - 1) * 10);
    expect(
      db.tables.placement_targets.filter((t) => t.status === "discovered"),
    ).toHaveLength(100 - judged.length);
  });

  it("starts nothing the deadline cannot fit, and yields with the rest still to judge", async () => {
    const db = seed(30);
    const { provider, stats } = judge();
    setLlmProvider(provider);
    await expect(qualify().run(ctx(db, 10_000))).rejects.toBeInstanceOf(
      StepIncomplete,
    );
    expect(stats.calls()).toBe(0);
    expect(
      db.tables.placement_targets.every((t) => t.status === "discovered"),
    ).toBe(true);
  });
});

describe("qualifyAdmission", () => {
  it("stops when the deadline cannot fit a batch", () => {
    expect(
      qualifyAdmission({ msLeft: 10_000, remainingUsd: 1, inFlight: 0 }),
    ).toBe("stop");
  });

  it("starts the first batch as the sequential loop did, whatever the budget says", () => {
    expect(
      qualifyAdmission({ msLeft: 120_000, remainingUsd: 0, inFlight: 0 }),
    ).toBe("start");
  });

  it("starts another only while the budget covers it beside the ones in flight", () => {
    const est = BATCH_COST_ESTIMATE_USD;
    expect(
      qualifyAdmission({
        msLeft: 120_000,
        remainingUsd: est * 3.01,
        inFlight: 2,
      }),
    ).toBe("start");
    expect(
      qualifyAdmission({
        msLeft: 120_000,
        remainingUsd: est * 2.5,
        inFlight: 2,
      }),
    ).toBe("wait");
  });
});
