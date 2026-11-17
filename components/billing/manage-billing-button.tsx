"use client";

import { CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBillingPortal } from "@/components/billing/use-billing-portal";

/** The Billing page's one action, with its failure said on the page. */
export function ManageBillingButton() {
  const { open, opening, error } = useBillingPortal();

  return (
    <div className="space-y-3">
      <Button
        onClick={open}
        disabled={opening}
        size="lg"
        className="h-11 w-full sm:w-auto"
      >
        {opening ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CreditCard className="mr-2 h-4 w-4" />
        )}
        {opening ? "Opening the billing portal..." : "Manage billing"}
      </Button>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}
    </div>
  );
}
