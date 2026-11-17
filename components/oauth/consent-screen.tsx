import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SCOPE_COPY } from "@/components/settings/scope-copy";
import type { ApiKeyScope } from "@/lib/api-keys";
import type { BusinessSummary } from "@/lib/tenancy";

/**
 * The consent screen an app such as claude.ai sends a person to
 * (app/oauth/authorize/page.tsx). A plain HTML form, no client script: it
 * works on any phone, and what it posts is re-checked by the decision route.
 *
 * What it must make plain (MCP authorization: the redirect URI's host is
 * shown clearly, with a warning for a loopback one): who is asking, under a
 * name the app chose itself; where the answer goes; what each permission
 * allows, with Read and Write ticked and Spend and Publish left for the
 * person to tick, as on a new API key; and which site.
 *
 * An account without an active plan may still connect (docs/API.md
 * "Without a plan"): the screen says plainly that every tool will answer
 * that the account has no active plan until it has one, so the person is
 * not surprised, and the connection starts working on its own once the plan
 * is active. Factual, not promotional: no price, no "upgrade".
 *
 * Deny comes first in the markup, so pressing Enter in the form declines.
 */

function siteLabel(site: Pick<BusinessSummary, "name" | "website_url">): string {
  return site.name || site.website_url || "Unnamed site";
}

function destination(redirectUri: string): { host: string; loopback: boolean } {
  try {
    const url = new URL(redirectUri);
    return { host: url.host, loopback: url.protocol === "http:" };
  } catch {
    return { host: redirectUri, loopback: false };
  }
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh flex flex-col">
      <header className="w-full border-b">
        <div className="w-full max-w-[1400px] mx-auto px-5 py-4">
          <span className="text-xl font-bold">GetTrafficFast</span>
        </div>
      </header>
      <main className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

export function ConsentError({ message }: { message: string }) {
  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">This connection cannot go ahead</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Nothing was shared. You can close this page.</p>
        </CardContent>
      </Card>
    </Shell>
  );
}

export interface ConsentScreenProps {
  /** Where the form posts. */
  action: string;
  /** The authorization request's own parameters, carried back as hidden fields. */
  hidden: Array<[string, string]>;
  clientName: string;
  redirectUri: string;
  requestedScopes: readonly ApiKeyScope[];
  defaultScopes: readonly ApiKeyScope[];
  sites: ReadonlyArray<Pick<BusinessSummary, "id" | "name" | "website_url">>;
  /** A site id, or `all`. */
  defaultSite: string;
  email: string | null;
  notice: string | null;
  /** False when the account has no active plan: the screen says what that means for the connection. Default true. */
  hasPlan?: boolean;
}

export function ConsentScreen(props: ConsentScreenProps) {
  const { host, loopback } = destination(props.redirectUri);
  const scopes = SCOPE_COPY.filter((scope) => props.requestedScopes.includes(scope.id));
  const asksToSpendOrPublish = props.requestedScopes.some((scope) => scope === "spend" || scope === "publish");
  const oldest = props.sites[0];

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl leading-tight break-words">Connect {props.clientName}?</CardTitle>
          <CardDescription>
            {props.clientName} is asking to use GetTrafficFast for you
            {props.email ? (
              <>
                , signed in as <span className="font-medium text-foreground break-all">{props.email}</span>
              </>
            ) : null}
            . It works through the same tools as the app, with the same checks: your sites only, your plan, the daily
            caps.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action={props.action} className="space-y-6">
            {props.hidden.map(([name, value], index) => (
              <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
            ))}

            <div className="rounded-md border bg-muted/50 p-3 text-sm space-y-2">
              <p>
                Your answer is sent to <strong className="break-all">{host}</strong>.
              </p>
              <p className="text-muted-foreground">
                The name above is the one the app gave itself. Allow only if you started this from an app you trust
                and you recognise this address.
              </p>
              {loopback && (
                <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  This address is on your own computer. Allow only if you just started connecting an app on this
                  device: any program running on it could be listening there.
                </p>
              )}
            </div>

            {props.hasPlan === false && (
              <div role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-1 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">This account has no active plan.</p>
                <p>
                  You can connect now, but until the account has an active plan every tool will answer that its
                  tools are unavailable. Once the plan is active, this connection works with nothing to redo. The plan
                  is managed in{" "}
                  <a href="/settings/billing" className="underline underline-offset-2">
                    Settings → Billing
                  </a>
                  .
                </p>
              </div>
            )}

            {props.notice && (
              <p role="alert" className="text-sm text-destructive">
                {props.notice}
              </p>
            )}

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium mb-2">What it may do</legend>
              {scopes.map((scope) => (
                <label key={scope.id} className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    name="grant"
                    value={scope.id}
                    defaultChecked={props.defaultScopes.includes(scope.id)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span>
                    <span className="font-medium">{scope.label}</span>
                    <span className="text-muted-foreground"> · {scope.detail}</span>
                  </span>
                </label>
              ))}
              {asksToSpendOrPublish && (
                <p className="text-xs text-muted-foreground">
                  Spend and Publish stay off unless you tick them. You can connect again later to change this.
                </p>
              )}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium mb-2">Which site</legend>
              {props.sites.map((site) => (
                <label key={site.id} className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="site"
                    value={site.id}
                    defaultChecked={props.defaultSite === site.id}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="break-all">Only {siteLabel(site)}</span>
                </label>
              ))}
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="site"
                  value="all"
                  defaultChecked={props.defaultSite === "all" || props.sites.length === 0}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="font-medium">All my sites</span>
                  <span className="text-muted-foreground">
                    {oldest
                      ? ` · The tools act on your oldest site, ${siteLabel(oldest)}, unless the app names another. Claude cannot name one, so with several sites, pick one.`
                      : " · You have not added a site yet. The app can add one for you."}
                  </span>
                </span>
              </label>
            </fieldset>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="submit" name="decision" value="deny" variant="outline" className="w-full sm:w-auto">
                Deny
              </Button>
              <Button type="submit" name="decision" value="allow" className="w-full sm:w-auto">
                Allow
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              You can disconnect it at any time in{" "}
              <a href="/settings/api-keys" className="underline underline-offset-2">
                Settings → Claude and API
              </a>
              , under Connected apps.
            </p>
          </form>
        </CardContent>
      </Card>
    </Shell>
  );
}
