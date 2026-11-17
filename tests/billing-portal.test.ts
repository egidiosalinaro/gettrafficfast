import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BILLING_PORTAL_ENDPOINT, requestBillingPortalUrl } from "@/lib/billing-portal";

/**
 * "Manage billing" did nothing on an iPhone: the portal link arrives after an
 * `await fetch`, and iOS blocks a `window.open` that is not inside the tap.
 * The link is now followed in the same tab, and a failure is text the page
 * shows, not a native alert.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(BILLING_PORTAL_ENDPOINT);
    expect(init?.method).toBe("POST");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("requestBillingPortalUrl", () => {
  it("returns the portal link", async () => {
    expect(await requestBillingPortalUrl(fakeFetch(200, { url: "https://billing.stripe.com/p/session" }))).toEqual({
      url: "https://billing.stripe.com/p/session",
    });
  });

  it("returns the server's reason when it refuses", async () => {
    expect(await requestBillingPortalUrl(fakeFetch(404, { error: "No subscription found" }))).toEqual({
      error: "No subscription found",
    });
  });

  it("says so when there is no link or no connection", async () => {
    const empty = await requestBillingPortalUrl(fakeFetch(200, {}));
    expect("error" in empty && empty.error).toMatch(/did not return a link/);
    const offline = await requestBillingPortalUrl((async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    expect("error" in offline && offline.error).toMatch(/could not be reached/);
  });
});

describe("every billing entry point", () => {
  const callers = [
    "components/billing/use-billing-portal.ts",
    "components/billing/manage-billing-button.tsx",
    "app/(app)/settings/billing/page.tsx",
    "components/user-menu.tsx",
  ];

  it("navigates in the same tab and never opens a window after the fetch", () => {
    expect(source("components/billing/use-billing-portal.ts")).toContain("window.location.assign(result.url)");
    for (const file of callers) {
      const text = source(file);
      expect(text, file).not.toContain("window.open");
      expect(text, file).not.toMatch(/\balert\(/);
    }
  });

  it("comes back to Billing from the portal", () => {
    expect(source("app/api/create-billing-portal-session/route.ts")).toContain("/settings/billing`");
  });
});
