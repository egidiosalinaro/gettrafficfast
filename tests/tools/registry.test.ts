import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistry, TOOLS } from "@/lib/tools/registry";
import { describeTool } from "@/lib/tools/schema";
import { defineTool, requiredScopes } from "@/lib/tools/tool";

/**
 * The registry and its definitions. What is pinned: a malformed tool fails
 * at load, not when an agent calls it; names are unique; every tool
 * publishes object JSON Schemas (MCP requires them); a paid tool needs the
 * spend scope; two tools publish, with the publish scope and confirm:
 * publish_article (to the customer's own site) and post_on_x (on X, from
 * the account the person connected), and nothing else posts anywhere.
 */

const ok = {
  name: "do_thing",
  title: "Do a thing",
  description: "Does one thing, for tests of the definition checks.",
  input: z.object({ id: z.string() }),
  output: z.object({ done: z.boolean() }),
  scope: "write" as const,
  paid: false,
  handler: async () => ({ done: true }),
};

describe("defineTool", () => {
  it("accepts a well-formed tool and freezes it", () => {
    const tool = defineTool(ok);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(requiredScopes(tool)).toEqual(["write"]);
    expect(requiredScopes(defineTool({ ...ok, paid: true }))).toEqual(["write", "spend"]);
  });

  it("refuses what an agent could not call reliably", () => {
    expect(() => defineTool({ ...ok, name: "Do-Thing" })).toThrow(/snake_case/);
    expect(() => defineTool({ ...ok, description: "Short." })).toThrow(/description/);
    expect(() => defineTool({ ...ok, input: z.string() as never })).toThrow(/input must be a z.object/);
    expect(() => defineTool({ ...ok, output: z.array(z.string()) as unknown as typeof ok.output })).toThrow(
      /output must be a z.object/
    );
    expect(() => defineTool({ ...ok, scope: "spend" as never })).toThrow(/scope/);
    expect(() => defineTool({ ...ok, scope: "read", paid: true })).toThrow(/paid tool/);
    expect(() => defineTool({ ...ok, owns: { targetId: "placement_targets" } })).toThrow(/not an input field/);
    expect(() => defineTool({ ...ok, owns: { id: "businesses" as never } })).toThrow(/ownership/);
  });
});

describe("createRegistry", () => {
  it("refuses two tools with one name", () => {
    const tool = defineTool(ok);
    expect(() => createRegistry([tool, tool])).toThrow(/Two tools are named do_thing/);
    expect(createRegistry([tool]).get("do_thing")).toBe(tool);
    expect(createRegistry([tool]).get("missing")).toBeUndefined();
  });
});

describe("TOOLS", () => {
  const names = TOOLS.list().map((t) => t.name);

  it("serves Today, then the Replies surface under its agreed names, first", () => {
    expect(names.slice(0, 25)).toEqual([
      "whoami",
      "get_today",
      "list_reply_inbox",
      "get_today_replies",
      "get_reply_target",
      "get_reply_metrics",
      "get_reply_stats",
      "run_reply_discovery",
      "add_x_post",
      "draft_reply",
      "edit_reply_draft",
      "write_own_reply",
      "correct_reply_draft",
      "get_reply_intent_url",
      "mark_reply_posted",
      "unmark_reply_posted",
      "set_reply_link",
      "paste_reply_links",
      "find_reply_link",
      "mark_reply_removed",
      "unmark_reply_removed",
      "snooze_reply_target",
      "dismiss_reply_target",
      "reopen_reply_target",
      "get_job",
    ]);
    expect(names).toEqual(expect.arrayContaining(["generate_article", "publish_article"]));
  });

  it("serves every read the screens make under the parity audit's names, read scope, free", () => {
    const reads = [
      "get_content",
      "list_calendar",
      "get_article",
      "list_deliveries",
      "list_keywords",
      "recommend_keywords",
      "get_visibility_overview",
      "list_prompts",
      "get_prompt_history",
      "list_visibility_runs",
      "get_visibility_settings",
      "get_results",
      "list_businesses",
      "get_business",
      "get_home",
      "get_today",
      "get_onboarding_status",
      "get_voice_settings",
      "list_draft_feedback",
      "list_integrations",
      "list_search_console_properties",
      "get_subscription",
      "compare_article_providers",
    ];
    expect(names).toEqual(expect.arrayContaining(reads));
    for (const name of reads) {
      expect(describeTool(TOOLS.get(name)!), name).toMatchObject({ scopes: ["read"], paid: false, subscription: true });
    }
  });

  it("publishes an object schema for every input and output", () => {
    for (const tool of TOOLS.list()) {
      const described = describeTool(tool);
      expect(described.inputSchema.type, tool.name).toBe("object");
      expect(described.outputSchema.type, tool.name).toBe("object");
      expect(described.inputSchema).not.toHaveProperty("$schema");
    }
  });

  it("needs spend for every tool that costs money, and the paywall for those and the subscriber-only ones", () => {
    const paid = TOOLS.list().filter((t) => t.paid).map((t) => t.name);
    expect(paid).toEqual(
      expect.arrayContaining(["run_reply_discovery", "add_x_post", "draft_reply", "correct_reply_draft", "generate_article"])
    );
    for (const tool of TOOLS.list()) {
      expect(describeTool(tool).scopes.includes("spend"), tool.name).toBe(tool.paid);
    }
    expect(describeTool(TOOLS.get("write_own_reply")!)).toMatchObject({ paid: false, subscription: true, scopes: ["write"] });
    expect(describeTool(TOOLS.get("publish_article")!)).toMatchObject({ paid: false, subscription: true, scopes: ["publish"] });
  });

  it("has two tools that publish, each needing the publish scope and confirm, and nothing else that posts", () => {
    expect(TOOLS.list().filter((t) => t.scope === "publish").map((t) => t.name).sort()).toEqual(["post_on_x", "publish_article"]);
    for (const name of ["post_on_x", "publish_article"]) {
      const input = TOOLS.get(name)!.input as unknown as z.ZodObject;
      expect(input.safeParse({ confirm: false }).success, name).toBe(false);
    }
    const allowed = ["add_x_post", "mark_reply_posted", "publish_article", "post_on_x"];
    expect(names.some((n) => /(^|_)(post|publish|send|tweet)(_|$)/.test(n) && !allowed.includes(n))).toBe(false);
  });

  it("checks the ownership of every id a tool takes", () => {
    for (const tool of TOOLS.list()) {
      // Every field that names rows: `…Id`, `…Ids`, or `ids`.
      const fields = Object.keys((tool.input as unknown as z.ZodObject).shape).filter((f) => /(^ids$|Ids?$)/.test(f));
      expect(Object.keys(tool.owns ?? {}).sort(), tool.name).toEqual(fields.sort());
    }
  });
});
