import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanUsagePanel, quotaLine } from "@/components/billing/plan-usage";
import type { PlanUsage, Quota } from "@/lib/limits/quotas";

/**
 * Settings → Billing, the plan card (the owner's decision, 2026-11-13). What
 * is pinned: the customer sees his quotas in his own units with a bar each,
 * this month's apart from the daily ones; a count that could not be read
 * says so, never 0; the limit for AI work shows only when it is reached (or
 * cannot be checked), with when it resets; and nothing on the page is a
 * dollar amount: no spend line, no ceiling field, no X API spend.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const quotas: Quota[] = [
  { id: "calendar_articles", label: "Articles on this month's calendar, one a day", used: 12, limit: 30, period: "month", window: "calendar_month_utc" },
  { id: "draft_reply", label: "Reply drafts", used: 9, limit: 60, period: "day", window: "rolling_24_hours" },
  { id: "run_visibility_check", label: "AI Visibility runs", used: 4, limit: 4, period: "day", window: "rolling_24_hours" },
  { id: "suggest_keywords", label: "Keyword suggestions", used: null, limit: 30, period: "day", window: "rolling_24_hours" },
];

const available: PlanUsage = { quotas, aiWork: { state: "available", message: null, resetsAt: null } };

describe("the plan card's quotas", () => {
  it("lists each limit in units, with a bar, this month apart from the daily limits", () => {
    const html = renderToStaticMarkup(<PlanUsagePanel usage={available} />);
    expect(html).toContain("This month");
    expect(html).toContain("Daily limits");
    expect(html.indexOf("This month")).toBeLessThan(html.indexOf("Daily limits"));
    expect(html).toContain("Articles on this month&#x27;s calendar, one a day");
    expect(html).toContain("12 of 30");
    expect(html).toContain("Reply drafts");
    expect(html).toContain("9 of 60");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="9"');
    expect(html).toContain('aria-valuemax="60"');
    expect(html).toContain("width:15%");
  });

  it("marks a limit that is used up, and says when a count could not be read instead of showing 0", () => {
    const html = renderToStaticMarkup(<PlanUsagePanel usage={available} />);
    expect(html).toMatch(/text-red-700 dark:text-red-400[^"]*">4 of 4/);
    expect(quotaLine(quotas[3])).toBe("could not be read");
    expect(html).toContain("could not be read");
    expect(html).not.toContain("0 of 30");
  });

  it("says nothing about AI work while it is open", () => {
    const html = renderToStaticMarkup(<PlanUsagePanel usage={available} />);
    expect(html).not.toContain("limit for AI work");
    expect(html).not.toContain('role="status"');
  });

  it("says when today's limit for AI work is reached and when it resets, without an amount", () => {
    const html = renderToStaticMarkup(
      <PlanUsagePanel
        usage={{
          quotas,
          aiWork: {
            state: "reached",
            message: "You've reached today's limit for AI work. It resets at about 10:00 UTC on Nov 15.",
            resetsAt: "2026-11-15T10:00:00.000Z",
          },
        }}
      />
    );
    expect(html).toContain("You&#x27;ve reached today&#x27;s limit for AI work. It resets at about 10:00 UTC on Nov 15.");
    expect(html).toContain("Work already queued waits and then goes on by itself.");
    expect(html).not.toContain("$");
  });

  it("says when it could not be checked", () => {
    const html = renderToStaticMarkup(
      <PlanUsagePanel
        usage={{ quotas, aiWork: { state: "unknown", message: "Today's AI work could not be checked right now.", resetsAt: null } }}
      />
    );
    expect(html).toContain("could not be checked right now");
  });
});

describe("the Billing page", () => {
  const page = source("app/(app)/settings/billing/page.tsx");

  it("is the plan card: plan and status from the subscription, the quotas, the billing portal", () => {
    expect(page).toContain("<PlanUsagePanel usage={usage} />");
    // The service role: today's AI work is counted on agent_runs.cost_usd,
    // which the customer's role cannot select. Only the verdict reaches the page.
    expect(page).toContain("loadPlanUsage(createAdminClient(), userId, selected?.id ?? null)");
    expect(page).toContain("<ManageBillingButton />");
    expect(page).toContain("summary.statusLabel");
  });

  it("shows no dollar amount: no spend line, no ceiling control, no X API spend", () => {
    for (const gone of ["AiSpendPanel", "readAccountSpend", "SpendLimitForm", "xSpendLineFor", "readPlatformCosts", "formatSpendUsd", "formatLimitUsd"]) {
      expect(page, gone).not.toContain(gone);
    }
    const panel = source("components/billing/plan-usage.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(panel).not.toMatch(/\$\{?[a-z]*usd|formatSpendUsd|formatLimitUsd|ceiling/i);
  });
});
