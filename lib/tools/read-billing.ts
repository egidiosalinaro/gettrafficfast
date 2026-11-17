import { z } from "zod";
import { getUserSubscription, hasActiveSubscription, summarizeSubscription } from "@/lib/subscription";
import { loadPlanUsage } from "@/lib/limits/quotas";
import { defineTool } from "./tool";

/**
 * Settings → Billing as a tool: what the account's subscription row says,
 * through the functions the Billing page and the paywall read
 * (lib/subscription.ts). The subscription is the account's, not a site's.
 * Only what the row holds: a date the row does not carry is null, never a
 * guess. Free; nothing here reaches the payment provider.
 */

export const getSubscription = defineTool({
  name: "get_subscription",
  title: "Get the subscription",
  description:
    "The account's subscription as Settings → Billing shows it: status, whether it is active (what paid tools need), the current period, whether it cancels at the period end, and the date that matters (trial end, next renewal or end) when the row has one. null when the account has no subscription.",
  input: z.object({}),
  output: z.object({
    subscription: z
      .object({
        status: z.string().describe("active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired or paused."),
        statusLabel: z.string(),
        active: z.boolean().describe("Active or trialing, and not past its period end: paid tools work."),
        currentPeriodStart: z.string().nullable(),
        currentPeriodEnd: z.string().nullable(),
        cancelAtPeriodEnd: z.boolean(),
        dateLabel: z.string().nullable().describe("Trial ends, Next renewal or Ends; null when the row carries no usable date."),
        date: z.string().nullable(),
        needsAttention: z.boolean().describe("Something to fix in the billing portal (a payment past due)."),
        updatedAt: z.string().nullable(),
      })
      .nullable(),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  async handler(ctx) {
    const [row, active] = await Promise.all([
      getUserSubscription(ctx.userId, ctx.client),
      hasActiveSubscription(ctx.userId, ctx.client),
    ]);
    if (!row) return { subscription: null };
    const summary = summarizeSubscription(row);
    return {
      subscription: {
        status: row.status,
        statusLabel: summary.statusLabel,
        active,
        currentPeriodStart: row.current_period_start ?? null,
        currentPeriodEnd: row.current_period_end ?? null,
        cancelAtPeriodEnd: row.cancel_at_period_end === true,
        dateLabel: summary.dateLabel,
        date: summary.date,
        needsAttention: summary.needsAttention,
        updatedAt: row.updated_at ?? null,
      },
    };
  },
});

/**
 * Settings → Plan's usage as a tool: what the plan lets the account do, in
 * its own units, and how much of it is used (lib/limits/quotas.ts, the
 * function the page reads). Never a dollar amount: the daily ceiling on AI
 * work protects the platform and reads only as reached or not, with when it
 * resets; the platform's provider spend is the owner's (`get_platform_costs`,
 * which this caller does not see unless he is one).
 */
export const getPlanUsage = defineTool({
  name: "get_plan_usage",
  title: "Get the plan's usage",
  description:
    "What the plan lets this account do and how much is used, as Settings → Plan shows it: one article a day on the site's calendar (this month), and the daily limits on reply drafts, draft corrections, articles generated on demand, reply discovery runs, AI Visibility runs, site analyses and suggestions (each over a rolling 24 hours, counted across the screens and every key). `used` is null when a count could not be read, never 0. `aiWork` says whether today's limit for AI work is reached and when it resets.",
  input: z.object({}),
  output: z.object({
    quotas: z.array(
      z.object({
        id: z.string().describe("The tool the limit holds (draft_reply), or calendar_articles."),
        label: z.string(),
        used: z.number().int().nullable().describe("Null when it could not be read."),
        limit: z.number().int(),
        period: z.enum(["day", "month"]),
        window: z.enum(["rolling_24_hours", "calendar_month_utc"]),
      })
    ),
    aiWork: z.object({
      state: z.enum(["available", "reached", "unknown"]).describe("unknown: it could not be checked, and new AI work waits until it can."),
      message: z.string().nullable(),
      resetsAt: z.string().nullable(),
    }),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  async handler(ctx) {
    // The counts read `jobs`, `tool_calls`, `draft_feedback`, `agent_runs`
    // and `account_limits`, the last three outside a key's narrowed client:
    // through the service role, every query filtered on this caller's user
    // (and the calendar on the caller's own site), as the runner's own
    // account check reads them (lib/limits/guard.ts).
    return loadPlanUsage(ctx.admin(), ctx.userId, ctx.caller.businessId ?? null);
  },
});

export const BILLING_READ_TOOLS = [getSubscription, getPlanUsage] as const;
