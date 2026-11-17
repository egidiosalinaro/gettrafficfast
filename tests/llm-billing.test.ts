import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FallbackProvider } from "@/lib/providers/llm/fallback";
import { LlmError, isLlmBillingRefusal, type LLMProvider } from "@/lib/providers/llm/types";
import { LLM_PAUSE_MS, llmPausedUntil, recordLlmBillingRefusal } from "@/lib/llm-billing";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * The operator hears about an account that cannot pay once a day, per
 * provider in Sentry and once in total by email, however many jobs and
 * crons run into the refusal. The pause it records is what holds the work.
 */

const sentry = vi.hoisted(() => ({ messages: [] as Array<{ message: string; options: Record<string, unknown> }> }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, options: Record<string, unknown>) => {
    sentry.messages.push({ message, options });
  },
  captureException: () => {},
}));

const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string }> }));
vi.mock("@/lib/notifications/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/email")>();
  return {
    ...actual,
    sendNotificationEmail: async (input: { to: string; subject: string }) => {
      emails.sent.push({ to: input.to, subject: input.subject });
      return true;
    },
  };
});

function refusal(providers: string[]): LlmError {
  return new LlmError("Gemini credits are depleted.", providers.join("+"), undefined, {
    retryable: false,
    report: false,
    billingRefused: providers,
  });
}

function failing(name: string, err: Error): LLMProvider {
  return {
    name,
    generateText: async () => {
      throw err;
    },
    generateStructured: async () => {
      throw err;
    },
  };
}

describe("billing refusal through the fallback", () => {
  it("is a refusal of the layer only when the primary and the fallback both cannot pay", async () => {
    const gemini = refusal(["gemini"]);
    const claude = refusal(["anthropic"]);
    const both = new FallbackProvider(
      { name: "gemini", build: () => failing("gemini", gemini) },
      { name: "anthropic", build: () => failing("anthropic", claude) }
    );
    const err = await both.generateText("x").catch((e: unknown) => e);
    expect(isLlmBillingRefusal(err)).toBe(true);
    expect((err as LlmError).billingRefused).toEqual(["gemini", "anthropic"]);

    // A depleted primary behind a fallback that timed out is not the whole
    // layer refusing: the next attempt may get through the fallback.
    const timedOut = new LlmError("Claude did not answer in time.", "anthropic");
    const mixed = new FallbackProvider(
      { name: "gemini", build: () => failing("gemini", gemini) },
      { name: "anthropic", build: () => failing("anthropic", timedOut) }
    );
    const mixedErr = await mixed.generateText("x").catch((e: unknown) => e);
    expect(isLlmBillingRefusal(mixedErr)).toBe(false);
  });

  it("is not a refusal for any other error", () => {
    expect(isLlmBillingRefusal(new LlmError("Gemini request failed: boom", "gemini"))).toBe(false);
    expect(isLlmBillingRefusal(new Error("credits are depleted"))).toBe(false);
  });
});

describe("recordLlmBillingRefusal", () => {
  let db: FakeSupabase;
  const supabase = () => db as unknown as SupabaseClient;

  beforeEach(() => {
    db = new FakeSupabase({ provider_pauses: [], operator_alerts: [] });
    sentry.messages.length = 0;
    emails.sent.length = 0;
    vi.stubEnv("OPERATOR_EMAIL", "ops@example.test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("alerts once per provider per UTC day, and emails the operator once", async () => {
    const morning = new Date("2026-11-08T08:00:00Z");
    const first = await recordLlmBillingRefusal(supabase(), refusal(["gemini", "anthropic"]), { source: "test" }, morning);
    expect(first?.reported).toEqual(["gemini", "anthropic"]);
    expect(first?.emailed).toBe(true);

    // Later the same day, from another job and from a cron.
    const noon = new Date("2026-11-08T12:00:00Z");
    const again = await recordLlmBillingRefusal(supabase(), refusal(["gemini", "anthropic"]), { source: "test" }, noon);
    await recordLlmBillingRefusal(supabase(), refusal(["gemini"]), { source: "cron" }, noon);
    expect(again?.reported).toEqual([]);
    expect(again?.emailed).toBe(false);

    expect(sentry.messages).toHaveLength(2);
    expect(sentry.messages.map((m) => m.options.fingerprint)).toEqual([
      ["llm-billing", "gemini"],
      ["llm-billing", "anthropic"],
    ]);
    expect(sentry.messages.every((m) => m.options.level === "fatal")).toBe(true);
    expect(emails.sent).toEqual([expect.objectContaining({ to: "ops@example.test" })]);

    // The next UTC day it is news again.
    const tomorrow = new Date("2026-11-09T00:30:00Z");
    const next = await recordLlmBillingRefusal(supabase(), refusal(["gemini"]), { source: "test" }, tomorrow);
    expect(next?.reported).toEqual(["gemini"]);
    expect(next?.emailed).toBe(true);
    expect(sentry.messages).toHaveLength(3);
    expect(emails.sent).toHaveLength(2);
  });

  it("pauses LLM work for an hour, and renews the pause when the refusal comes back", async () => {
    const now = new Date("2026-11-08T08:00:00Z");
    const outcome = await recordLlmBillingRefusal(supabase(), refusal(["gemini"]), { source: "test" }, now);
    expect(outcome?.pausedUntil.getTime()).toBe(now.getTime() + LLM_PAUSE_MS);
    expect(await llmPausedUntil(supabase(), new Date("2026-11-08T08:30:00Z"))).toEqual(outcome?.pausedUntil);
    // Expired: the next run tries again.
    expect(await llmPausedUntil(supabase(), new Date("2026-11-08T09:00:01Z"))).toBeNull();

    const later = new Date("2026-11-08T09:05:00Z");
    await recordLlmBillingRefusal(supabase(), refusal(["gemini"]), { source: "test" }, later);
    expect(db.tables.provider_pauses).toHaveLength(1);
    const renewed = await llmPausedUntil(supabase(), new Date("2026-11-08T09:30:00Z"));
    expect(renewed?.getTime()).toBe(later.getTime() + LLM_PAUSE_MS);
    // Renewed, not re-announced.
    expect(sentry.messages).toHaveLength(1);
  });

  it("does nothing for an error that is not a billing refusal", async () => {
    const outcome = await recordLlmBillingRefusal(supabase(), new LlmError("Gemini did not answer in time.", "gemini"), {
      source: "test",
    });
    expect(outcome).toBeNull();
    expect(db.tables.provider_pauses).toHaveLength(0);
    expect(sentry.messages).toHaveLength(0);
  });

  it("reads an unreadable pause as no pause, so a missing table never stops production", async () => {
    const broken = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }),
      }),
    } as unknown as SupabaseClient;
    expect(await llmPausedUntil(broken)).toBeNull();
  });
});
