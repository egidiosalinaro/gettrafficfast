import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSubscription } from "@/lib/subscription";
import { BUSINESS_COOKIE, listBusinesses, pickBusiness } from "@/lib/tenancy";
import { CONSENT_NOTICES, authorizationQuery, prepareConsent, type ConsentNotice } from "@/lib/oauth/authorize";
import { MAX_LIVE_GRANTS, OAUTH_PATHS } from "@/lib/oauth/config";
import { countLiveGrants } from "@/lib/oauth/tokens";
import { ConsentError, ConsentScreen } from "@/components/oauth/consent-screen";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect an app",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The authorization endpoint's page (docs/API.md "Connect from claude.ai").
 * An app such as claude.ai sends the person here; the request is checked
 * first (lib/oauth/authorize.ts), then a session is required (sign-in comes
 * back here through `next`), then the person sees who is asking, where they
 * will be sent back to, and chooses the permissions and the site (and, for an
 * account without an active plan, that its tools will be unavailable until it
 * has one). The form
 * posts to /oauth/authorize/decision, which re-checks everything.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admin = createAdminClient();

  const step = await prepareConsent(params, { admin, userId: user?.id ?? null });
  if (step.kind === "redirect") redirect(step.location);
  if (step.kind === "page" || !user) return <ConsentError message={step.kind === "page" ? step.message : "Sign in to continue."} />;

  const sites = await listBusinesses(supabase, user.id);
  const cookieStore = await cookies();
  const selected = pickBusiness(sites, cookieStore.get(BUSINESS_COOKIE)?.value ?? null);
  const live = await countLiveGrants(admin, user.id);
  // Connecting is allowed without a plan; every tool then answers the one
  // standard refusal (lib/tools/runner.ts). The screen says so up front.
  const hasPlan = await hasActiveSubscription(user.id, supabase);
  const notice = typeof params.notice === "string" && params.notice in CONSENT_NOTICES ? (params.notice as ConsentNotice) : null;

  return (
    <ConsentScreen
      action={OAUTH_PATHS.decision}
      hidden={[...authorizationQuery(params).entries()]}
      clientName={step.request.client.clientName}
      redirectUri={step.request.redirectUri}
      requestedScopes={step.request.requestedScopes}
      defaultScopes={step.defaults}
      sites={sites}
      defaultSite={selected?.id ?? "all"}
      email={user.email ?? null}
      hasPlan={hasPlan}
      notice={notice ? CONSENT_NOTICES[notice] : live !== null && live >= MAX_LIVE_GRANTS ? CONSENT_NOTICES.too_many_apps : null}
    />
  );
}
