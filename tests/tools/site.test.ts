import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Caller } from "@/lib/api-auth";
import { ownerScopedClient } from "@/lib/supabase/owner-scoped";
import { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, uuid } from "./support";

/**
 * The `site` argument (lib/tools/site.ts): how an agent that cannot send the
 * x-gtf-business header (claude.ai) chooses the site in each call. Pinned:
 * a site named by id, name or domain, case-insensitively; the handler, the
 * ownership check and the client's writes all move to that site; an
 * ambiguous or unknown name, or a site outside the grant, is refused with
 * the sites the grant covers; a grant for one site never reaches another;
 * without `site`, the default site as before; the argument is published on
 * every site-scoped tool and only there; the prompts take it too.
 */

vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));

import { createRegistry } from "@/lib/tools/registry";
import { runTool } from "@/lib/tools/runner";
import { defineTool } from "@/lib/tools/tool";
import { describeTool } from "@/lib/tools/schema";
import { chooseSite, siteHost } from "@/lib/tools/site";
import { createMcpServer } from "@/lib/tools/mcp";
import { renderPrompt } from "@/lib/tools/prompts";
import { TOOLS } from "@/lib/tools/registry";

const SITE_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_A = uuid("a", 1);
const T_B = uuid("b", 1);

const seen: Array<{ businessId: string; input: Record<string, unknown> }> = [];

const note = defineTool({
  name: "note_on_site",
  title: "Note on a site",
  description: "Writes one keyword on the caller's site, for tests of the site argument.",
  input: z.object({ phrase: z.string().default("hello") }),
  output: z.object({ businessId: z.string() }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    seen.push({ businessId: ctx.businessId, input });
    const { error } = await ctx.client.from("keywords").insert({ user_id: ctx.userId, business_id: ctx.businessId, keyword: input.phrase });
    if (error) throw new Error(error.message);
    return { businessId: ctx.businessId };
  },
});

const touch = defineTool({
  name: "touch_target",
  title: "Touch a target",
  description: "Reads one target, for tests of ownership with the site argument.",
  input: z.object({ targetId: z.string().uuid() }),
  output: z.object({ businessId: z.string() }),
  scope: "read",
  paid: false,
  owns: { targetId: "placement_targets" },
  handler: async (ctx) => ({ businessId: ctx.businessId }),
});

const registry = createRegistry([note, touch]);

function seed() {
  return new FakeSupabase({
    businesses: [
      ...businesses(),
      // A second "Bravo", on another address: the name alone is ambiguous.
      { id: SITE_D, user_id: USER, name: "Bravo", website_url: "https://www.bravo-shop.test/", created_at: "2026-03-01T00:00:00Z" },
    ],
    placement_targets: [
      { id: T_A, user_id: USER, business_id: SITE_A },
      { id: T_B, user_id: USER, business_id: SITE_B },
    ],
    keywords: [],
  });
}

/** An app connected over OAuth: every site (the default A), or one. */
function oauthCaller(db: FakeSupabase, only?: string): Caller {
  const businessIds = only ? [only] : [SITE_A, SITE_B, SITE_D];
  const businessId = only ?? SITE_A;
  return {
    via: "oauth",
    userId: USER,
    businessId,
    businessIds,
    client: ownerScopedClient(db as unknown as SupabaseClient, { userId: USER, businessIds: [businessId] }),
    scopes: ["read", "write"],
    keyId: null,
    oauth: { clientId: "gtfci_test", grantId: "grant-1", siteLimited: Boolean(only) },
  };
}

const run = (db: FakeSupabase, caller: Caller, name: string, input: unknown) =>
  runTool(caller, name, input, { registry, admin: () => db as unknown as SupabaseClient });

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  seen.length = 0;
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  error.mockRestore();
});

describe("the site argument", () => {
  it("keeps the default site when the call names none", async () => {
    const db = seed();
    expect(await run(db, oauthCaller(db), "note_on_site", {})).toEqual({ ok: true, output: { businessId: SITE_A } });
  });

  it("moves the call to the site named by id, by name or by domain, case-insensitively, writes included", async () => {
    const db = seed();
    for (const site of [SITE_B, SITE_B.toUpperCase(), "ACME", "bravo.test", "https://www.Bravo.test/blog", "bravo-shop.test"]) {
      const expected = site === "ACME" ? SITE_A : site === "bravo-shop.test" ? SITE_D : SITE_B;
      expect(await run(db, oauthCaller(db), "note_on_site", { site, phrase: "x" }), site).toEqual({
        ok: true,
        output: { businessId: expected },
      });
    }
    // The handler never sees `site`; its write landed on the named site, through a client narrowed to it.
    expect(seen.every((call) => !("site" in call.input))).toBe(true);
    expect((db.tables.keywords as Array<{ business_id: string }>).map((k) => k.business_id)).toEqual([
      SITE_B,
      SITE_B,
      SITE_A,
      SITE_B,
      SITE_B,
      SITE_D,
    ]);
    // The audit row names the site the call was about.
    await vi.waitFor(() => expect(db.tables.tool_calls).toHaveLength(6));
    expect((db.tables.tool_calls as Array<{ business_id: string }>)[0].business_id).toBe(SITE_B);
  });

  it("checks ownership on the named site", async () => {
    const db = seed();
    expect(await run(db, oauthCaller(db), "touch_target", { targetId: T_B })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await run(db, oauthCaller(db), "touch_target", { targetId: T_B, site: "Acme" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await run(db, oauthCaller(db), "touch_target", { targetId: T_B, site: "bravo.test" })).toEqual({
      ok: true,
      output: { businessId: SITE_B },
    });
  });

  it("refuses an ambiguous name, listing the sites", async () => {
    const db = seed();
    const refused = await run(db, oauthCaller(db), "note_on_site", { site: "bravo" });
    expect(refused).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
    expect(!refused.ok && refused.error.message).toContain("names 2 sites");
    expect(!refused.ok && refused.error.message).toContain(SITE_D);
    expect(seen).toEqual([]);
  });

  it("refuses an unknown site and another account's site, listing the sites the grant covers", async () => {
    const db = seed();
    for (const site of ["Zephyr", SITE_C, "Charlie", "charlie.test"]) {
      const refused = await run(db, oauthCaller(db), "note_on_site", { site });
      expect(refused, site).toMatchObject({ ok: false, status: 404, error: { code: "business_not_found" } });
      const message = !refused.ok ? refused.error.message : "";
      expect(message).toContain("Acme (acme.test");
      expect(message.split("Sites it may use:")[1]).not.toMatch(/Charlie|cccccccc/);
    }
    expect(seen).toEqual([]);
    expect(db.tables.keywords).toEqual([]);
  });

  it("never lets a grant for one site reach another, by id, name or domain", async () => {
    const db = seed();
    for (const site of [SITE_B, "Bravo", "bravo.test"]) {
      const refused = await run(db, oauthCaller(db, SITE_A), "note_on_site", { site });
      expect(refused, site).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_business" } });
      const message = !refused.ok ? refused.error.message : "";
      expect(message).toContain("limited to one site");
      expect(message.split("Sites it may use:")[1]).toBe(` Acme (acme.test, id ${SITE_A}).`);
    }
    // Its own site, named, is fine.
    expect(await run(db, oauthCaller(db, SITE_A), "note_on_site", { site: "acme" })).toEqual({ ok: true, output: { businessId: SITE_A } });
    // A key for one site, the same.
    expect(await run(db, apiCaller(db), "note_on_site", { site: "Bravo" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business" },
    });
    expect(seen.map((call) => call.businessId)).toEqual([SITE_A]);
  });

  it("refuses a site that is not a string", async () => {
    const db = seed();
    expect(await run(db, oauthCaller(db), "note_on_site", { site: 42 })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input" },
    });
  });
});

describe("chooseSite and siteHost", () => {
  it("reads a domain out of what a person types", () => {
    expect(siteHost("https://www.Acme.test/blog/")).toBe("acme.test");
    expect(siteHost("acme.test")).toBe("acme.test");
    expect(siteHost("Acme")).toBeNull();
    expect(siteHost(null)).toBeNull();
  });

  it("matches only among the sites the grant covers", () => {
    const owned = [
      { id: SITE_A, name: "Acme", website_url: "https://acme.test" },
      { id: SITE_B, name: "Bravo", website_url: "https://bravo.test" },
    ];
    expect(chooseSite(owned, [SITE_A, SITE_B], "bravo")).toMatchObject({ ok: true, site: { id: SITE_B } });
    expect(chooseSite(owned, [SITE_A], "bravo")).toMatchObject({ ok: false, error: { code: "forbidden_business" } });
    expect(chooseSite(owned, [SITE_A], "bravo", "api_key")).toMatchObject({
      ok: false,
      error: { code: "forbidden_business", message: expect.stringContaining("This key is limited") },
    });
  });
});

describe("published schemas and the MCP surface", () => {
  it("adds an optional site to every site-scoped tool, and to no other", () => {
    for (const tool of TOOLS.list()) {
      const schema = describeTool(tool).inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      if (tool.name === "set_default_site") {
        // Its own site field is the new default, required (null clears it), not the runner's argument.
        expect(schema.required ?? [], tool.name).toContain("site");
      } else if (tool.needsBusiness === false) {
        expect(schema.properties ?? {}, tool.name).not.toHaveProperty("site");
      } else {
        expect(schema.properties, tool.name).toHaveProperty("site", expect.objectContaining({ type: "string" }));
        expect(schema.required ?? [], tool.name).not.toContain("site");
      }
    }
  });

  it("refuses a tool that names its own field site", () => {
    expect(() =>
      defineTool({
        name: "clash",
        title: "Clash",
        description: "Has a field the runner reserves, which must fail.",
        input: z.object({ site: z.string() }),
        output: z.object({}),
        scope: "read",
        paid: false,
        handler: async () => ({}),
      })
    ).toThrow(/site is the runner's argument/);
  });

  it("takes site on tools/call, for an app connected over OAuth", async () => {
    const db = seed();
    const server = createMcpServer(oauthCaller(db), { registry, admin: () => db as unknown as SupabaseClient });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "note_on_site")?.inputSchema.properties).toHaveProperty("site");
    const result = await client.callTool({ name: "note_on_site", arguments: { site: "bravo.test" } });
    expect(result.structuredContent).toEqual({ businessId: SITE_B });
    await client.close();
  });
});

describe("the routines", () => {
  it("pass the named site on every call", () => {
    const daily = renderPrompt("daily_routine", { site: "Bravo" }, { scopes: ["read", "write"], businessIds: [SITE_A, SITE_B] });
    expect(daily.ok && daily.text).toContain('pass site "Bravo" on every tool call');
    const weekly = renderPrompt("weekly_review", { site: "bravo.test" }, { scopes: ["read"] });
    expect(weekly.ok && weekly.text).toContain('pass site "bravo.test" on every tool call');
  });

  it("ask which site first when the connection covers several and none is named", () => {
    const several = renderPrompt("daily_routine", {}, { scopes: ["read", "write"], businessIds: [SITE_A, SITE_B] });
    expect(several.ok && several.text).toMatch(/covers several sites[\s\S]*ask me which site/);
    const one = renderPrompt("daily_routine", { site: "" }, { scopes: ["read", "write"], businessIds: [SITE_A] });
    expect(one.ok && one.text).not.toMatch(/several sites|pass site/);
  });
});
