import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { API_ERROR_CODES } from "@/lib/api-errors";
import { toMcpTool } from "@/lib/tools/mcp";
import { TOOLS } from "@/lib/tools/registry";
import { describeTool } from "@/lib/tools/schema";

/**
 * The write tools as the catalogue and MCP describe them. Pinned: the names
 * of the 2026-11-09 parity audit; which ones cost money (spend and the
 * paywall), which only need a subscription (scheduling), which delete data
 * (MCP's destructiveHint, so a client asks first), which take `confirm`;
 * that no tool takes a destination's credentials (connecting WordPress or a
 * webhook stays a screen); and the migration the API-key reschedule needs.
 */

const WRITE_TOOLS = [
  "add_keywords",
  "update_keyword",
  "delete_keywords",
  "suggest_keywords",
  "schedule_keywords",
  "reschedule_article",
  "unschedule_article",
  "retry_article",
  "add_prompts",
  "update_prompt",
  "delete_prompt",
  "import_prompts_from_keywords",
  "suggest_prompts",
  "update_visibility_settings",
  "run_visibility_check",
  "create_business",
  "update_business",
  "analyze_website",
  "update_automation_settings",
  "update_media_settings",
  "update_voice_settings",
  "promote_feedback_to_notes",
  "add_about_you_fact",
  "remove_about_you_fact",
  "disconnect_integration",
  "get_search_console_connect_url",
  "select_search_console_property",
  "sync_search_console",
  "disconnect_search_console",
];

const tool = (name: string) => {
  const found = TOOLS.get(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
};

describe("the write tools", () => {
  it("are registered under the parity audit's names", () => {
    const names = TOOLS.list().map((t) => t.name);
    for (const name of WRITE_TOOLS) expect(names, name).toContain(name);
  });

  it("cost money only where a model or an engine is called: spend and the paywall", () => {
    const paid = WRITE_TOOLS.filter((name) => tool(name).paid);
    expect(paid).toEqual(["suggest_keywords", "suggest_prompts", "run_visibility_check", "analyze_website"]);
    for (const name of paid) expect(describeTool(tool(name))).toMatchObject({ scopes: ["write", "spend"], subscription: true });
    expect(describeTool(tool("schedule_keywords"))).toMatchObject({ scopes: ["write"], paid: false, subscription: true });
    expect(describeTool(tool("get_search_console_connect_url"))).toMatchObject({ scopes: ["read"], subscription: true });
  });

  it("mark the ones that delete data as destructive on MCP", () => {
    const destructive = WRITE_TOOLS.filter((name) => toMcpTool(tool(name)).annotations?.destructiveHint);
    expect(destructive).toEqual([
      "delete_keywords",
      "unschedule_article",
      "delete_prompt",
      "disconnect_integration",
      "disconnect_search_console",
    ]);
    expect(toMcpTool(tool("add_keywords")).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("take confirm where a call can switch spending on, false by default", () => {
    const withConfirm = WRITE_TOOLS.filter((name) => "confirm" in (tool(name).input as unknown as z.ZodObject).shape);
    expect(withConfirm).toEqual([
      "update_visibility_settings",
      "run_visibility_check",
      "update_automation_settings",
      "update_media_settings",
    ]);
    for (const name of withConfirm) {
      expect(describeTool(tool(name)).inputSchema).toMatchObject({ properties: { confirm: { type: "boolean", default: false } } });
    }
    expect(API_ERROR_CODES).toContain("confirmation_required");
  });

  it("never take a destination's credentials: connecting stays a screen", () => {
    const names = TOOLS.list().map((t) => t.name);
    expect(names).not.toContain("connect_wordpress");
    expect(names).not.toContain("connect_webhook");
    for (const t of TOOLS.list()) {
      const fields = Object.keys((t.input as unknown as z.ZodObject).shape);
      expect(fields.filter((f) => /password|secret|token|apiKey/i.test(f)), t.name).toEqual([]);
    }
  });
});

describe("20261109231500_move_article_for_owner.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261109231500_move_article_for_owner.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("is move_article with the owner passed in, for the service role only", () => {
    expect(code).toContain("create or replace function public.move_article_for_owner( p_owner uuid, p_article_id uuid, p_target_date date )");
    expect(code).toContain("security invoker");
    expect(code).toContain("set search_path = ''");
    expect(code).toContain("where id = p_article_id and user_id = p_owner");
    expect(code).toContain("set constraints all deferred");
    for (const role of ["public", "anon", "authenticated"]) {
      expect(code).toContain(`revoke all on function public.move_article_for_owner(uuid, uuid, date) from ${role};`);
    }
    expect(code).toContain("grant execute on function public.move_article_for_owner(uuid, uuid, date) to service_role;");
  });

  it("applies without a confirmation: no drop", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
  });
});
