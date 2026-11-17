import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ONBOARDING_STEPS, OPTIONAL_ONBOARDING_STEPS, nextOnboardingStep } from "@/lib/onboarding";
import { hasClaudeConnected } from "@/lib/onboarding-status";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Connect Claude" is a suggestion under the checklist, never a step that
 * keeps it open: the app does everything on its own.
 */

const LATER = "2026-12-14T10:00:00Z";

describe("the optional Connect Claude step", () => {
  it("is not one of the steps that count toward done", () => {
    const required = ONBOARDING_STEPS.map((step) => step.key as string);
    for (const step of OPTIONAL_ONBOARDING_STEPS) expect(required).not.toContain(step.key);
    const allDone = Object.fromEntries(ONBOARDING_STEPS.map((step) => [step.key, true]));
    expect(nextOnboardingStep(allDone as never)).toBeNull();
  });

  it("is done with a live key or a live claude.ai grant, and not with revoked ones", async () => {
    const client = (rows: Record<string, Array<Record<string, unknown>>>) => new FakeSupabase(rows) as unknown as SupabaseClient;
    expect(await hasClaudeConnected(client({ api_keys: [], oauth_tokens: [] }), "u1")).toBe(false);
    expect(
      await hasClaudeConnected(client({ api_keys: [{ id: "k", user_id: "u1", revoked_at: null }], oauth_tokens: [] }), "u1")
    ).toBe(true);
    expect(
      await hasClaudeConnected(
        client({
          api_keys: [{ id: "k", user_id: "u1", revoked_at: "2026-11-01T00:00:00Z" }],
          oauth_tokens: [{ id: "t", user_id: "u1", rotated_at: null, revoked_at: null, refresh_expires_at: LATER }],
        }),
        "u1"
      )
    ).toBe(true);
    expect(
      await hasClaudeConnected(client({ api_keys: [{ id: "k", user_id: "u2", revoked_at: null }], oauth_tokens: [] }), "u1")
    ).toBe(false);
  });
});
