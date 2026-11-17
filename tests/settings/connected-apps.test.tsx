import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { ConnectedApps, type ConnectedAppRow } from "@/components/settings/connected-apps";

/**
 * Settings → API keys → Connected apps, rendered. What is pinned: each
 * grant shows the app, where it receives its codes, its scopes, its site
 * and when it was last used, with a Revoke; an empty list says so; a list
 * that could not be read says that instead of "No connected apps".
 */

const SITE = { id: "site-1", name: "Acme", website_url: "https://acme.test" };

const app = (over: Partial<ConnectedAppRow>): ConnectedAppRow => ({
  id: "f-1",
  clientName: "Claude",
  redirectHost: "claude.ai",
  scopes: ["read", "write"],
  businessId: null,
  grantedAt: "2026-11-10T09:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

describe("ConnectedApps", () => {
  it("lists each grant with its app, scopes, site and last use", () => {
    const html = renderToStaticMarkup(
      <ConnectedApps
        apps={[
          app({ businessId: "site-1", scopes: ["read", "write", "spend"], lastUsedAt: "2026-11-10T11:45:00.000Z" }),
          app({ id: "f-2", clientName: "Inspector", redirectHost: "localhost" }),
        ]}
        sites={[SITE]}
      />
    );
    expect(html).toContain("Connected apps");
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    expect(html).toContain("Only Acme");
    expect(html).toContain("spend");
    expect(html).toContain("Last used 2026-11-10 11:45 UTC");
    expect(html).toContain("Connected 2026-11-10 09:00 UTC");
    expect(html).toContain("Every site");
    expect(html).toContain("Last used never");
    expect(html.match(/Revoke/g)).toHaveLength(2);
  });

  it("says when there are none, and when they could not be read", () => {
    expect(renderToStaticMarkup(<ConnectedApps apps={[]} sites={[]} />)).toContain("No connected apps.");
    const failed = renderToStaticMarkup(<ConnectedApps apps={[]} sites={[]} loadError="relation does not exist" />);
    expect(failed).toContain("could not be loaded");
    expect(failed).not.toContain("No connected apps.");
  });
});
