import type { SupabaseClient } from "@supabase/supabase-js";
import { monthOf, nextMonthStart, PROVIDER_SPEND_TABLE } from "./provider-spend";
import {
  ACCOUNT_LIMITS_TABLE,
  MAX_DAILY_SPEND_USD,
  MIN_DAILY_SPEND_USD,
  SPEND_WINDOW_MS,
  globalCeiling,
  tallyRuns,
  type CeilingSource,
  type RunRow,
} from "./spend";
import { X_SEARCH_CALL_WORST_USD, X_SPEND_PROVIDER, readXApiStatus } from "@/lib/placements/x-budget";

/**
 * The owner's costs (docs/API.md "The owner's costs"): what the platform
 * pays this month per provider, and what each account spent on models in the
 * last 24 hours against its daily ceiling. Read by /settings/costs and by
 * the owner-only tool `get_platform_costs`, both only after
 * `isPlatformOwnerHere` (lib/owner.ts), and only through the service role: the
 * ledger and other accounts' runs are no customer's to read.
 *
 * Honest by the same rules as everything else: a ledger that cannot be read
 * says so (null, with the error), never $0; a run with no recorded cost is
 * counted at the conservative estimate and shown apart (`tallyRuns`, the
 * function the ceiling itself counts with); past the pages read, an
 * account's figure is a floor and says so.
 *
 * Bounded: one query per table, never one per account. At most
 * `MAX_RUN_PAGES` × 1,000 runs, 1,000 limit rows and 1,000 users.
 */

const RUN_PAGE_SIZE = 1000;
const MAX_RUN_PAGES = 10;
const MAX_ACCOUNTS = 1000;

/** How the ledger's provider keys read on the page. Unknown keys read as themselves. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  [X_SPEND_PROVIDER]: "X API",
};

export interface ProviderCost {
  provider: string;
  label: string;
  /** The month's estimated cost from the ledger; 0 when no row exists (nothing was called). */
  costUsd: number;
  calls: number;
  posts: number;
  /** The hard monthly cap, when the platform sets one for this provider. */
  capUsd: number | null;
  /** True when the next call would cross the cap. */
  capReached: boolean;
  /** Whether the platform opted in to this provider; null when the ledger is all we know. */
  enabled: boolean | null;
  pausedUntil: string | null;
}

export interface AccountCost {
  userId: string;
  email: string | null;
  /** The account's first site, by name or address, to recognise it. */
  site: string | null;
  /** The subscription status, when it has a live one. */
  subscription: string | null;
  /** Model cost over the 24 hours: measured plus estimated. */
  spentUsd: number;
  measuredUsd: number;
  estimatedUsd: number;
  runs: number;
  unmeasuredRuns: number;
  ceilingUsd: number;
  ceilingSource: CeilingSource;
  reached: boolean;
  freesAt: string | null;
}

export interface PlatformCosts {
  /** `YYYY-MM`, UTC. */
  month: string;
  /** When the monthly caps reset: the first instant of next month, UTC. */
  resetsAt: string;
  /** Null when the ledger could not be read. */
  providers: ProviderCost[] | null;
  providersError: string | null;
  /** Since when the accounts' spend is counted (a rolling 24 hours). */
  since: string;
  /** Null when the runs could not be read. */
  accounts: AccountCost[] | null;
  accountsError: string | null;
  /** False when there were more runs than were read: the totals are floors. */
  accountsComplete: boolean;
  /** Every account's model cost over the 24 hours, summed; null when not read. */
  aiTotalUsd: number | null;
  /** The ceiling an account without its own row has, and where it comes from. */
  defaultCeiling: { usd: number; source: CeilingSource };
  bounds: { minUsd: number; maxUsd: number };
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message).slice(0, 300);
  return String(error).slice(0, 300);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function readProviders(admin: SupabaseClient, now: Date): Promise<{ providers: ProviderCost[] | null; error: string | null }> {
  const month = monthOf(now);
  let rows: Array<{ provider: string; cost_usd: unknown; calls: unknown; posts: unknown }>;
  try {
    const { data, error } = await admin
      .from(PROVIDER_SPEND_TABLE)
      .select("provider, cost_usd, calls, posts")
      .eq("month", month)
      .order("provider", { ascending: true });
    if (error) return { providers: null, error: messageOf(error) };
    rows = (data ?? []) as typeof rows;
  } catch (error) {
    return { providers: null, error: messageOf(error) };
  }

  const providers: ProviderCost[] = rows.map((row) => ({
    provider: row.provider,
    label: PROVIDER_LABELS[row.provider] ?? row.provider,
    costUsd: Number(row.cost_usd ?? 0),
    calls: Number(row.calls ?? 0),
    posts: Number(row.posts ?? 0),
    capUsd: null,
    capReached: false,
    enabled: null,
    pausedUntil: null,
  }));

  // X has a hard monthly cap the platform sets (X_API_MONTHLY_CAP_USD): show
  // it against the cap, and show it even before its first call this month.
  const x = await readXApiStatus(admin, now).catch(() => null);
  let xRow = providers.find((p) => p.provider === X_SPEND_PROVIDER);
  if (!xRow && x?.enabled) {
    xRow = { provider: X_SPEND_PROVIDER, label: PROVIDER_LABELS[X_SPEND_PROVIDER], costUsd: 0, calls: 0, posts: 0, capUsd: null, capReached: false, enabled: true, pausedUntil: null };
    providers.unshift(xRow);
  }
  if (xRow && x) {
    xRow.capUsd = x.capUsd;
    xRow.enabled = x.enabled;
    xRow.pausedUntil = x.pausedUntil;
    xRow.capReached = xRow.costUsd + X_SEARCH_CALL_WORST_USD > x.capUsd;
  }
  return { providers, error: null };
}

interface AccountRunRow extends RunRow {
  user_id: string;
}

async function readRuns(admin: SupabaseClient, since: Date): Promise<{ rows: AccountRunRow[]; complete: boolean } | { error: string }> {
  const rows: AccountRunRow[] = [];
  for (let page = 0; page < MAX_RUN_PAGES; page++) {
    try {
      const { data, error } = await admin
        .from("agent_runs")
        .select("user_id, agent, model, cost_usd, created_at")
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .range(page * RUN_PAGE_SIZE, page * RUN_PAGE_SIZE + RUN_PAGE_SIZE - 1);
      if (error) return { error: `agent_runs: ${messageOf(error)}` };
      const batch = (data ?? []) as AccountRunRow[];
      rows.push(...batch);
      if (batch.length < RUN_PAGE_SIZE) return { rows, complete: true };
    } catch (error) {
      return { error: `agent_runs: ${messageOf(error)}` };
    }
  }
  return { rows, complete: false };
}

async function readCeilings(admin: SupabaseClient): Promise<Map<string, number>> {
  const ceilings = new Map<string, number>();
  const { data, error } = await admin.from(ACCOUNT_LIMITS_TABLE).select("user_id, daily_spend_usd").limit(MAX_ACCOUNTS);
  if (error) throw new Error(`account_limits: ${messageOf(error)}`);
  for (const row of (data ?? []) as Array<{ user_id: string; daily_spend_usd: unknown }>) {
    const usd = Number(row.daily_spend_usd);
    // The same rule as readDailySpendCeiling: a stored value out of bounds is not a ceiling.
    if (Number.isFinite(usd) && usd >= MIN_DAILY_SPEND_USD && usd <= MAX_DAILY_SPEND_USD) ceilings.set(row.user_id, usd);
  }
  return ceilings;
}

async function readLiveSubscriptions(admin: SupabaseClient): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  const { data } = await admin
    .from("subscriptions")
    .select("user_id, status")
    .in("status", ["active", "trialing", "past_due"])
    .limit(MAX_ACCOUNTS);
  for (const row of (data ?? []) as Array<{ user_id: string; status: string }>) {
    if (!live.has(row.user_id) || row.status === "active") live.set(row.user_id, row.status);
  }
  return live;
}

async function readLabels(admin: SupabaseClient, userIds: string[]): Promise<{ emails: Map<string, string>; sites: Map<string, string> }> {
  const emails = new Map<string, string>();
  const sites = new Map<string, string>();
  if (userIds.length === 0) return { emails, sites };
  const wanted = new Set(userIds);
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: MAX_ACCOUNTS });
    for (const user of data?.users ?? []) {
      if (wanted.has(user.id) && user.email) emails.set(user.id, user.email);
    }
  } catch {
    // Labels only: an account still shows by its id.
  }
  try {
    const { data } = await admin
      .from("businesses")
      .select("user_id, name, website_url, created_at")
      .in("user_id", userIds)
      .order("created_at", { ascending: true });
    for (const row of (data ?? []) as Array<{ user_id: string; name: string | null; website_url: string | null }>) {
      if (!sites.has(row.user_id)) sites.set(row.user_id, row.name || row.website_url || "");
    }
  } catch {
    // Labels only.
  }
  return { emails, sites };
}

export async function readPlatformCosts(admin: SupabaseClient, now: Date = new Date()): Promise<PlatformCosts> {
  const since = new Date(now.getTime() - SPEND_WINDOW_MS);
  const fallback = globalCeiling();
  const base = {
    month: monthOf(now).slice(0, 7),
    resetsAt: nextMonthStart(now).toISOString(),
    since: since.toISOString(),
    defaultCeiling: fallback,
    bounds: { minUsd: MIN_DAILY_SPEND_USD, maxUsd: MAX_DAILY_SPEND_USD },
  };

  const [providers, runs, ceilings, subscriptions] = await Promise.all([
    readProviders(admin, now),
    readRuns(admin, since),
    readCeilings(admin).catch((error: unknown) => error as Error),
    readLiveSubscriptions(admin).catch(() => new Map<string, string>()),
  ]);

  if ("error" in runs || ceilings instanceof Error) {
    return {
      ...base,
      providers: providers.providers,
      providersError: providers.error,
      accounts: null,
      accountsError: "error" in runs ? runs.error : (ceilings as Error).message,
      accountsComplete: false,
      aiTotalUsd: null,
    };
  }

  // Runs come newest first, and stay in that order per account: tallyRuns needs it.
  const byUser = new Map<string, AccountRunRow[]>();
  for (const row of runs.rows) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row);
    else byUser.set(row.user_id, [row]);
  }

  const ids = [...new Set([...byUser.keys(), ...ceilings.keys(), ...subscriptions.keys()])].slice(0, MAX_ACCOUNTS);
  const labels = await readLabels(admin, ids);

  const accounts: AccountCost[] = ids.map((userId) => {
    const own = ceilings.get(userId);
    const ceiling = own !== undefined ? { usd: own, source: "account" as const } : fallback;
    const tally = tallyRuns(byUser.get(userId) ?? [], ceiling.usd, now);
    const reached = tally.totalUsd >= ceiling.usd;
    return {
      userId,
      email: labels.emails.get(userId) ?? null,
      site: labels.sites.get(userId) || null,
      subscription: subscriptions.get(userId) ?? null,
      spentUsd: tally.totalUsd,
      measuredUsd: tally.measuredUsd,
      estimatedUsd: tally.estimatedUsd,
      runs: tally.measuredRuns + tally.unmeasuredRuns,
      unmeasuredRuns: tally.unmeasuredRuns,
      ceilingUsd: ceiling.usd,
      ceilingSource: ceiling.source,
      reached,
      freesAt: reached && tally.freesAt ? tally.freesAt.toISOString() : null,
    };
  });
  accounts.sort((a, b) => b.spentUsd - a.spentUsd || (a.email ?? a.userId).localeCompare(b.email ?? b.userId));

  return {
    ...base,
    providers: providers.providers,
    providersError: providers.error,
    accounts,
    accountsError: null,
    accountsComplete: runs.complete,
    aiTotalUsd: round2(accounts.reduce((sum, account) => sum + account.spentUsd, 0)),
  };
}
