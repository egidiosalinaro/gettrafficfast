"use client";

import { useCallback, useState } from "react";
import { requestBillingPortalUrl } from "@/lib/billing-portal";

/**
 * Opening the billing portal from a button: the link is fetched, then the
 * page goes there in the same tab (see lib/billing-portal.ts for why not a new
 * tab). A failure is returned as text for the caller to show inline.
 */
export function useBillingPortal() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async () => {
    setOpening(true);
    setError(null);
    const result = await requestBillingPortalUrl();
    if ("url" in result) {
      // Stay in the "opening" state: the page is about to leave.
      window.location.assign(result.url);
      return;
    }
    setError(result.error);
    setOpening(false);
  }, []);

  return { open, opening, error };
}
