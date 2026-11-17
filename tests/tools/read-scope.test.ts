import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { ART_A1, Q_A1, readSeed } from "./read-support";

/**
 * Every read the screens make, as a tool: a key with only the read scope
 * calls each one (no write, no spend), and a key without it is refused
 * before anything is read. Since 2026-11-16 reading needs an active plan
 * too, like every tool.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/providers/citations/registry", () => ({
  getCitationProviders: () => [{ name: "gemini" }, { name: "perplexity" }],
}));
vi.mock("@/lib/integrations/crypto", () => ({ decryptSecret: (v: string) => v, encryptSecret: (v: string) => v }));
vi.mock("@/lib/providers/analytics/search-console", () => ({
  refreshAccessToken: async () => "token",
  listSites: async () => [],
  SearchConsoleProvider: class {},
}));

import { runTool } from "@/lib/tools/runner";

const READS: Array<[string, Record<string, unknown>]> = [
  ["get_content", {}],
  ["list_calendar", {}],
  ["get_article", { articleId: ART_A1 }],
  ["list_deliveries", {}],
  ["list_keywords", {}],
  ["recommend_keywords", {}],
  ["get_visibility_overview", {}],
  ["list_prompts", {}],
  ["get_prompt_history", { queryId: Q_A1 }],
  ["list_visibility_runs", {}],
  ["get_visibility_settings", {}],
  ["get_results", {}],
  ["list_businesses", {}],
  ["get_business", {}],
  ["get_home", {}],
  ["get_onboarding_status", {}],
  ["get_voice_settings", {}],
  ["list_draft_feedback", {}],
  ["list_integrations", {}],
  ["list_search_console_properties", {}],
  ["get_subscription", {}],
  ["compare_article_providers", {}],
];

let db: FakeSupabase;
beforeEach(() => {
  db = readSeed();
  m.db = db;
});

describe("the read tools", () => {
  it.each(READS)("%s runs with a key that has only the read scope", async (name, input) => {
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), name, input);
    expect(run, JSON.stringify(run).slice(0, 300)).toMatchObject({ ok: true });
  });

  it.each(READS)("%s is refused to a key without the read scope", async (name, input) => {
    const run = await runTool(apiCaller(db, { scopes: ["write"] }), name, input);
    expect(run).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    // Only the key's limit, the plan and the audit row (lib/tools/usage.ts) touch the database.
    expect(db.calls.filter((call) => !call.endsWith(":tool_calls") && !call.endsWith(":subscriptions"))).toEqual([]);
  });

  it("is refused without an active plan, with the one standard answer, before anything is read", async () => {
    db.tables.subscriptions = [];
    for (const [name, input] of READS) {
      db.calls.length = 0;
      const run = await runTool(apiCaller(db, { scopes: ["read"] }), name, input);
      expect(run, name).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
      expect(db.calls.filter((call) => !call.endsWith(":tool_calls") && !call.endsWith(":subscriptions")), name).toEqual([]);
    }
  });
});
