import { describe, expect, it } from "vitest";
import { registryFor } from "@/lib/tools/owner";
import { describeTool, type JsonSchema } from "@/lib/tools/schema";

/**
 * What the platform pays is never the customer's (owner's decision,
 * 2026-11-14: "Customers pay GTF and that's it, everything included"). A
 * customer reaches the tools through a key, a connected app or the public
 * catalogue, all of which describe the registry `registryFor` gives him.
 * What is pinned, for every tool in a non-owner's registry:
 *
 * - no input or output field is named for a cost, a price or a dollar
 *   amount (`costUsd`, `avgCostUsd`, `priceUsd`, …);
 * - no description, of the tool or of any field, states a dollar figure,
 *   USD or cents. The one exception is `cpc`: what advertisers pay Google
 *   per click, a market figure about the customer's keyword, not a cost of
 *   the platform's;
 * - the owner's registry is the only one with `get_platform_costs`.
 */

const CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const ENV = { PLATFORM_OWNER_USER_IDS: OWNER };

const COST_KEY = /cost|usd|price|spent|billed/i;
const DOLLARS = /\$\s?\d|\bUSD\b|\bcents?\b/i;
/** Fields whose dollars are a market figure about the customer's keyword, not what the platform pays. */
const MARKET_FIELDS = new Set(["cpc"]);

interface Finding {
  tool: string;
  path: string;
  what: string;
}

function walk(tool: string, node: unknown, path: string, findings: Finding[], field: string | null = null): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(tool, item, `${path}[${index}]`, findings, field));
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as JsonSchema;
  if (typeof schema.description === "string" && DOLLARS.test(schema.description) && !(field && MARKET_FIELDS.has(field))) {
    findings.push({ tool, path, what: `description: ${schema.description}` });
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (COST_KEY.test(name)) findings.push({ tool, path: `${path}.${name}`, what: "a cost field" });
      walk(tool, child, `${path}.${name}`, findings, name);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "description") continue;
    walk(tool, value, `${path}.${key}`, findings, field);
  }
}

describe("a customer's tools carry no cost", () => {
  const tools = registryFor(CUSTOMER, ENV).list();

  it("is the customer's registry, without the owner's tools", () => {
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.map((t) => t.name)).not.toContain("get_platform_costs");
    expect(registryFor(OWNER, ENV).get("get_platform_costs")).toBeDefined();
  });

  it("names no cost, price or dollar field in any input or output schema, and no dollar figure in any field's description", () => {
    const findings: Finding[] = [];
    for (const tool of tools) {
      const described = describeTool(tool);
      walk(tool.name, described.inputSchema, "input", findings);
      walk(tool.name, described.outputSchema, "output", findings);
    }
    expect(findings).toEqual([]);
  });

  it("states no dollar figure in any tool's title or description", () => {
    const priced = tools
      .filter((tool) => DOLLARS.test(`${tool.title} ${tool.description}`))
      .map((tool) => tool.name);
    expect(priced).toEqual([]);
  });

  it("the pattern catches what it is for", () => {
    const findings: Finding[] = [];
    walk(
      "probe",
      {
        type: "object",
        properties: {
          avgCostUsd: { type: "number" },
          note: { type: "string", description: "about $0.04 each" },
          cpc: { type: "number", description: "Estimated cost per click in USD." },
        },
      },
      "output",
      findings
    );
    expect(findings.map((f) => f.path)).toEqual(["output.avgCostUsd", "output.note"]);
  });
});
