import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANUAL_ACTIONS } from "@/lib/placements/workflow";
import { MANUAL_ACTION_PARITY, PARITY_EXCEPTION_KINDS, ROUTE_PARITY } from "@/lib/tools/parity";
import { TOOLS } from "@/lib/tools/registry";

/**
 * GUI ↔ tool parity (lib/tools/parity.ts). The routes are read from the
 * file system, not from a list someone keeps: a new route that changes
 * something fails here until it has a tool, or a written reason not to.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MUTATING = /export\s+(?:async\s+function|const)\s+(POST|PATCH|PUT|DELETE)\b/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" || entry === "route.tsx" ? [full] : [];
  });
}

/** `METHOD /path` for every mutating handler under app/, route groups left out of the path. */
function mutatingRoutes(): string[] {
  const keys: string[] = [];
  for (const file of routeFiles(path.join(root, "app"))) {
    const route =
      "/" +
      path
        .relative(path.join(root, "app"), path.dirname(file))
        .split(path.sep)
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .join("/");
    const source = readFileSync(file, "utf8");
    expect(source, `${route} re-exports a handler: list it by hand`).not.toMatch(/export\s*\{[^}]*\bas\s+(POST|PATCH|PUT|DELETE)\b/);
    for (const match of source.matchAll(MUTATING)) keys.push(`${match[1]} ${route}`);
  }
  return keys.sort();
}

describe("every route that changes something is a tool, or says why not", () => {
  const routes = mutatingRoutes();

  it("finds the routes (the scan itself works)", () => {
    expect(routes).toContain("POST /api/placements/[id]/action");
    expect(routes).toContain("DELETE /api/keywords/delete");
    expect(routes.length).toBeGreaterThan(50);
  });

  it("maps or excepts every mutating route", () => {
    const missing = routes.filter((key) => !(key in ROUTE_PARITY));
    expect(missing, "add a tool, or an exception with its reason, in lib/tools/parity.ts").toEqual([]);
  });

  it("lists no route that does not exist", () => {
    const stale = Object.keys(ROUTE_PARITY).filter((key) => !routes.includes(key));
    expect(stale).toEqual([]);
  });

  it("maps only to tools in the registry, and every exception to a written reason", () => {
    for (const [key, entry] of Object.entries(ROUTE_PARITY)) {
      if ("tools" in entry) {
        expect(entry.tools.length, key).toBeGreaterThan(0);
        for (const name of entry.tools) expect(TOOLS.get(name), `${key} → ${name}`).toBeDefined();
      } else {
        expect(PARITY_EXCEPTION_KINDS[entry.except], key).toBeTruthy();
      }
    }
  });

  it("keeps the exceptions to the decided kinds: keys, billing, credentials, the spend ceiling, sign-in, machines", () => {
    const excepted = Object.entries(ROUTE_PARITY)
      .filter(([, entry]) => "except" in entry)
      .map(([key]) => key);
    // Every excepted /api route that is not a cron or the surfaces, by name, so a new one is a decision in review.
    expect(excepted.filter((key) => !key.includes("/api/cron/") && !key.includes("/oauth/")).sort()).toEqual(
      [
        "DELETE /api/api-keys/[id]",
        "DELETE /api/connected-apps/[id]",
        "DELETE /api/mcp",
        "POST /api/api-keys",
        "POST /api/business/select",
        "POST /api/create-billing-portal-session",
        "POST /api/create-checkout-session",
        "POST /api/gettrafficfast",
        "POST /api/integrations/webhook/connect",
        "POST /api/integrations/wordpress/connect",
        "POST /api/jobs/tick",
        "POST /api/mcp",
        "POST /api/owner/spend-limit",
        "POST /api/owner/reviewer-account",
        "POST /api/auth/sign-in-method",
        "POST /api/auth/set-password",
        "POST /api/stripe-webhook",
        "POST /api/v1/tools/[name]",
      ].sort()
    );
  });

  it("no tool mints keys, revokes connections or sets the spend ceiling", () => {
    const names = TOOLS.list().map((t) => t.name);
    for (const forbidden of [/api_key/, /connected_app/, /spend_limit|ceiling/, /checkout|billing_portal/]) {
      expect(names.filter((name) => forbidden.test(name))).toEqual([]);
    }
  });
});

describe("the action route, one tool per action", () => {
  it("maps every manual action to a registered tool, approve excepted", () => {
    for (const action of MANUAL_ACTIONS) {
      const entry = MANUAL_ACTION_PARITY[action];
      expect(entry, action).toBeDefined();
      if (typeof entry === "string") expect(TOOLS.get(entry), `${action} → ${entry}`).toBeDefined();
      else expect(action).toBe("approve");
    }
    const routeTools = (ROUTE_PARITY["POST /api/placements/[id]/action"] as { tools: readonly string[] }).tools;
    const actionTools = Object.values(MANUAL_ACTION_PARITY).filter((t): t is string => typeof t === "string");
    expect([...routeTools].sort()).toEqual([...actionTools].sort());
  });
});
