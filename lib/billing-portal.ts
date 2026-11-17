/**
 * Asks the server for a Stripe billing portal link.
 *
 * Callers navigate with `window.location.assign(url)`, never `window.open`:
 * iOS Safari only lets a page open a new tab directly inside the tap, and
 * this link arrives after an `await fetch`, so a new tab is silently blocked
 * and the button looked dead on an iPhone. The portal's return link brings
 * the owner back to Settings, Billing.
 */

export const BILLING_PORTAL_ENDPOINT = "/api/create-billing-portal-session";

export type BillingPortalResult = { url: string } | { error: string };

export async function requestBillingPortalUrl(
  fetchImpl: typeof fetch = fetch
): Promise<BillingPortalResult> {
  try {
    const response = await fetchImpl(BILLING_PORTAL_ENDPOINT, { method: "POST" });
    const data = (await response.json().catch(() => ({}))) as {
      url?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      return {
        error:
          typeof data.error === "string" && data.error
            ? data.error
            : "The billing portal could not be opened. Try again in a minute.",
      };
    }
    if (typeof data.url !== "string" || !data.url) {
      return { error: "The billing portal did not return a link. Try again in a minute." };
    }
    return { url: data.url };
  } catch {
    return { error: "The billing portal could not be reached. Check the connection and try again." };
  }
}
