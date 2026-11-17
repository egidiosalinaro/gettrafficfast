import { cn } from "@/lib/utils";
import { formatLimitUsd, formatResetTime, formatSpendUsd } from "@/lib/limits/spend";
import type { AccountCost, PlatformCosts, ProviderCost } from "@/lib/limits/platform-costs";
import { CeilingForm } from "./ceiling-form";

/**
 * /settings/costs, for a platform owner only: what the platform pays this
 * month per provider, and each account's model cost over the last 24 hours
 * against its daily ceiling, with the control that sets it. Pure render of
 * `readPlatformCosts` (lib/limits/platform-costs.ts), so it is tested as is.
 *
 * What could not be read says so, never $0; estimates say they are.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-11" as "November 2026". */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return MONTH_NAMES[(m ?? 1) - 1] ? `${MONTH_NAMES[(m ?? 1) - 1]} ${year}` : month;
}

function Bar({ share, alarm, label }: { share: number; alarm: boolean; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full", alarm ? "bg-red-500" : "bg-foreground/70")} style={{ width: `${percent}%` }} />
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderCost }) {
  const capped = provider.capUsd !== null;
  return (
    <li className="space-y-1.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{provider.label}</span>
        <span className={cn("shrink-0 text-sm font-medium tabular-nums", provider.capReached && "text-red-700 dark:text-red-400")}>
          {formatSpendUsd(provider.costUsd)}
          {capped ? ` of ${formatLimitUsd(provider.capUsd as number)}` : ""}
        </span>
      </div>
      {capped && <Bar share={provider.costUsd / Math.max(provider.capUsd as number, 0.01)} alarm={provider.capReached} label={`${provider.label} against its monthly cap`} />}
      <p className="text-xs text-muted-foreground">
        {provider.calls} {provider.calls === 1 ? "call" : "calls"}
        {provider.posts > 0 ? ` · ${provider.posts} ${provider.posts === 1 ? "post" : "posts"} returned` : ""}
        {capped ? "" : " · no monthly cap"}
        {provider.enabled === false ? " · off" : ""}
        {provider.pausedUntil ? ` · paused until ${formatResetTime(new Date(provider.pausedUntil))}` : ""}
        {provider.capReached ? " · cap reached: every call is refused until the 1st" : ""}
      </p>
    </li>
  );
}

function accountLabel(account: AccountCost): string {
  return account.email ?? account.site ?? account.userId;
}

function AccountRow({ account }: { account: AccountCost }) {
  const label = accountLabel(account);
  const detail = [account.email ? account.site : null, account.subscription].filter(Boolean).join(" · ");
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        <span className={cn("shrink-0 text-sm font-medium tabular-nums", account.reached && "text-red-700 dark:text-red-400")}>
          {formatSpendUsd(account.spentUsd)} of {formatLimitUsd(account.ceilingUsd)}
        </span>
      </div>
      <Bar share={account.spentUsd / account.ceilingUsd} alarm={account.reached} label={`${label} against its daily ceiling`} />
      <p className="text-xs text-muted-foreground">
        {detail ? `${detail} · ` : ""}
        {account.runs} AI {account.runs === 1 ? "run" : "runs"}
        {account.unmeasuredRuns > 0
          ? ` · ${formatSpendUsd(account.estimatedUsd)} estimated for ${account.unmeasuredRuns} that recorded no cost`
          : ""}
        {" · "}
        {account.ceilingSource === "account" ? "its own ceiling" : "the default ceiling"}
        {account.reached && account.freesAt ? ` · reached, frees at about ${formatResetTime(new Date(account.freesAt))}` : ""}
      </p>
      <CeilingForm userId={account.userId} accountLabel={label} currentUsd={account.ceilingUsd} />
    </li>
  );
}

export function PlatformCostsView({ costs }: { costs: PlatformCosts }) {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold">Platform costs</h1>
        <p className="text-muted-foreground">
          Only platform owners see this page. Customers see their plan&rsquo;s limits in their own units, never these
          amounts. Figures are estimates from published prices, not invoices.
        </p>
      </div>

      <section aria-labelledby="providers-heading" className="rounded-2xl border border-border bg-card p-4">
        <h2 id="providers-heading" className="text-lg font-semibold">
          {monthLabel(costs.month)}, per provider
        </h2>
        {costs.providers === null ? (
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">
            The ledger could not be read right now{costs.providersError ? `: ${costs.providersError}` : ""}. A provider
            whose ledger cannot be read is not called.
          </p>
        ) : costs.providers.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No metered provider has been called this month.</p>
        ) : (
          <ul className="divide-y divide-border">
            {costs.providers.map((provider) => (
              <ProviderRow key={provider.provider} provider={provider} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          From the ledger (<code>provider_spend</code>). Monthly caps reset at {formatResetTime(new Date(costs.resetsAt))}.
          Model cost is not in this ledger: it is counted per account below.
        </p>
      </section>

      <section aria-labelledby="accounts-heading" className="rounded-2xl border border-border bg-card p-4">
        <h2 id="accounts-heading" className="text-lg font-semibold">
          AI spend, last 24 hours
        </h2>
        {costs.accounts === null ? (
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">
            The accounts&rsquo; spend could not be read right now{costs.accountsError ? `: ${costs.accountsError}` : ""}.
            Until it can, paid work is refused rather than run unchecked.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm">
              {costs.accountsComplete ? "" : "At least "}
              {formatSpendUsd(costs.aiTotalUsd ?? 0)} of model cost across {costs.accounts.length}{" "}
              {costs.accounts.length === 1 ? "account" : "accounts"}.
            </p>
            {!costs.accountsComplete && (
              <p className="text-xs text-muted-foreground">
                There were more runs than one reading takes, so these totals are floors.
              </p>
            )}
            {costs.accounts.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No account has a run, a ceiling or a live subscription.</p>
            ) : (
              <ul className="divide-y divide-border">
                {costs.accounts.map((account) => (
                  <AccountRow key={account.userId} account={account} />
                ))}
              </ul>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          The default ceiling is {formatLimitUsd(costs.defaultCeiling.usd)}
          {costs.defaultCeiling.source === "env" ? " (ACCOUNT_DAILY_SPEND_USD)" : ""}. An account&rsquo;s own ceiling is{" "}
          {formatLimitUsd(costs.bounds.minUsd)} to {formatLimitUsd(costs.bounds.maxUsd)}: lowering it applies at once,
          raising it asks you to confirm. At its ceiling an account&rsquo;s new AI work is refused and queued work waits;
          the customer reads only that today&rsquo;s limit for AI work is reached, and when it resets.
        </p>
      </section>
    </div>
  );
}
