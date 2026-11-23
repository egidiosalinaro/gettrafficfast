import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { ApiKeysManager, type ApiKeyRow } from "@/components/settings/api-keys-manager";

/**
 * Settings → API keys, rendered. What is pinned: the MCP endpoint and the
 * Claude Code line are on the page; a live key shows its name, prefix,
 * site, scopes and when it was last used, never a secret; revoked keys are
 * listed apart; and spending is not ticked by default.
 */

const MCP = "https://gettrafficfa.st/api/mcp";
const TOOLS = "https://gettrafficfa.st/api/v1/tools";
const SITE = { id: "site-1", name: "Acme", website_url: "https://acme.test" };

const key = (over: Partial<ApiKeyRow>): ApiKeyRow => ({
  id: "k-1",
  name: "Claude Code",
  prefix: "gtf_AbCd",
  businessId: null,
  defaultBusinessId: null,
  scopes: ["read", "write"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  ...over,
});

describe("ApiKeysManager", () => {
  it("shows a key for every site its default site, with a picker, when the account has several", () => {
    const BRAVO = { id: "site-2", name: "Bravo", website_url: "https://bravo.test" };
    const html = renderToStaticMarkup(
      <ApiKeysManager
        keys={[key({ defaultBusinessId: "site-2" }), key({ id: "k-3", name: "Site key", businessId: "site-1" })]}
        sites={[SITE, BRAVO]}
        mcpUrl={MCP}
        toolsUrl={TOOLS}
      />
    );
    expect(html.match(/Default site/g)).toHaveLength(1);
    expect(html).toContain("Oldest site (Acme)");
    expect(html).toMatch(/<option value="site-2" selected="">Bravo<\/option>/);
    // One site only: nothing to choose.
    const single = renderToStaticMarkup(<ApiKeysManager keys={[key({})]} sites={[SITE]} mcpUrl={MCP} toolsUrl={TOOLS} />);
    expect(single).not.toContain("Default site");
  });

  it("shows the endpoint, the Claude Code line, and each key without its secret", () => {
    const html = renderToStaticMarkup(
      <ApiKeysManager
        keys={[
          key({ businessId: "site-1", scopes: ["read", "write", "spend"], lastUsedAt: "2026-11-09T12:30:00.000Z" }),
          key({ id: "k-2", name: "Old script", prefix: "gtf_Zz00", revokedAt: "2026-11-01T08:00:00.000Z" }),
        ]}
        sites={[SITE]}
        mcpUrl={MCP}
        toolsUrl={TOOLS}
      />
    );
    expect(html).toContain(MCP);
    expect(html).toContain(`claude mcp add --transport http gettrafficfast ${MCP} --header &quot;Authorization: Bearer gtf_…&quot;`);
    expect(html).toContain("gtf_AbCd…");
    expect(html).toContain("Only Acme");
    expect(html).toContain("spend");
    expect(html).toContain("Last used 2026-11-09 12:30 UTC");
    expect(html).toContain("Revoked keys (1)");
    expect(html).toContain("revoked 2026-11-01 08:00 UTC");
  });

  it("starts a new key with read and write, and spending and publishing unticked", () => {
    const html = renderToStaticMarkup(<ApiKeysManager keys={[]} sites={[SITE]} mcpUrl={MCP} toolsUrl={TOOLS} />);
    expect(html).toContain("No live keys yet.");
    const checked = [...html.matchAll(/role="checkbox" aria-checked="(true|false)"/g)].map((m) => m[1]);
    expect(checked).toEqual(["true", "true", "false", "false"]);
    // Publish can be ticked now that publish_article exists; nothing is disabled.
    expect(html).not.toMatch(/role="checkbox"[^>]*\sdisabled=""/);
    expect(html).not.toContain("data-disabled");
    expect(html).toContain("Publish an article to your site");
  });

  it("shows each key's calls over the last 7 days, never the model cost in dollars", () => {
    const html = renderToStaticMarkup(
      <ApiKeysManager
        keys={[key({ id: "k-1" }), key({ id: "k-2", name: "Script" }), key({ id: "k-3", name: "Idle" })]}
        sites={[SITE]}
        mcpUrl={MCP}
        toolsUrl={TOOLS}
        usage={{
          "k-1": { calls: 12 },
          "k-2": { calls: 1 },
        }}
      />
    );
    expect(html).toContain("12 calls in the last 7 days");
    expect(html).toContain("1 call in the last 7 days");
    expect(html).toContain("No calls in the last 7 days");
    expect(html).not.toContain("$0.42");
    expect(html).not.toMatch(/model spend|spend not measured/);
    expect(html).toContain("Settings → Billing");
  });

  it("says usage is unavailable rather than showing zeros when the audit log cannot be read", () => {
    const html = renderToStaticMarkup(
      <ApiKeysManager keys={[key({})]} sites={[SITE]} mcpUrl={MCP} toolsUrl={TOOLS} usage={null} />
    );
    expect(html).toContain("Usage is not available right now");
    expect(html).not.toContain("No calls in the last 7 days");
  });
});
