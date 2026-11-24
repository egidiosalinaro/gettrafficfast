/**
 * The facts the legal pages (/privacy-policy, /terms-and-conditions) state,
 * in one place, so they are written once and tested.
 *
 * The pages are public statements: everything here must match what the code
 * and the production configuration do today. The sub-processor list is held
 * to the code by tests/legal.test.ts: every file under lib/providers has to
 * be classified in PROVIDER_MODULES, and every provider named here has to
 * point at code that still uses it. A new vendor fails that test until it is
 * disclosed here (and on the page), which is the point.
 *
 * Vendors are named here, above the provider layer, on purpose: a privacy
 * policy has to name its processors. Nothing in this file calls a vendor.
 */

/**
 * When the legal texts last changed. A fixed date, never `new Date()`: the
 * line says when the text changed, not when the page was rendered. Change it
 * with the text, in the same commit.
 */
export const LEGAL_LAST_UPDATED = "2026-11-24";

/** "17 November 2026", the way the pages print LEGAL_LAST_UPDATED. */
export function formatLegalDate(iso: string = LEGAL_LAST_UPDATED): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Who provides the service and is the data controller. */
export const LEGAL_OPERATOR = {
  name: "Egidio Salinaro",
  form: "sole proprietor (ditta individuale)",
  street: "Via Baccina 87",
  postcode: "00184",
  town: "Roma",
  country: "Italy",
} as const;

/**
 * The Italian VAT number (Partita IVA). Empty until the owner provides it;
 * while empty, no VAT line is printed anywhere (never a placeholder on the
 * live page). A constant rather than a server env var because the footer
 * renders it too, and it is public information by law.
 */
export const LEGAL_VAT_NUMBER = "18573881002";

/** The VAT line to print, or null when there is no number to print. */
export function vatNumberLine(value: string | null | undefined = LEGAL_VAT_NUMBER): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? `VAT number (Partita IVA): ${trimmed}` : null;
}

/** The operator's address on one line. */
export function operatorAddressLine(): string {
  return `${LEGAL_OPERATOR.street}, ${LEGAL_OPERATOR.postcode} ${LEGAL_OPERATOR.town}, ${LEGAL_OPERATOR.country}`;
}

export type ProviderId =
  | "supabase"
  | "vercel"
  | "stripe"
  | "sentry"
  | "datafast"
  | "google-gemini"
  | "google-search-console"
  | "google-sign-in"
  | "youtube"
  | "anthropic"
  | "serper"
  | "x"
  | "unavatar";

export interface ServiceProvider {
  id: ProviderId;
  name: string;
  /** What GTF uses it for. */
  purpose: string;
  /** What personal data reaches it. */
  data: string;
  /** The provider's privacy page. */
  privacyUrl: string;
  /**
   * Where the code uses it: a file that must exist and contain `contains`.
   * tests/legal.test.ts checks it, so a provider removed from the code
   * cannot stay listed unnoticed.
   */
  evidence: { file: string; contains: string };
}

/**
 * The providers that process personal data for the hosted service at
 * gettrafficfa.st, as enabled in production on LEGAL_LAST_UPDATED (checked
 * against the production environment's variable names, not their values).
 */
export const SERVICE_PROVIDERS: readonly ServiceProvider[] = [
  {
    id: "supabase",
    name: "Supabase",
    purpose: "Database, sign-in and sign-in emails. The database is hosted in the EU (Paris, France).",
    data: "Everything the account holds: email address, sites, settings, drafts, articles, measurements, logs.",
    privacyUrl: "https://supabase.com/privacy",
    evidence: { file: "lib/supabase/server.ts", contains: "@supabase/ssr" },
  },
  {
    id: "vercel",
    name: "Vercel",
    purpose: "Hosting of the website, the app and the API, and its request logs.",
    data: "Requests to the service, including IP address, browser details and the content of requests.",
    privacyUrl: "https://vercel.com/legal/privacy-policy",
    evidence: { file: "vercel.json", contains: "crons" },
  },
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Subscription payments, invoices and the billing portal.",
    data: "Email address, payment details (entered on Stripe's pages, never seen by GetTrafficFast), billing address, subscription status.",
    privacyUrl: "https://stripe.com/privacy",
    evidence: { file: "app/api/stripe-webhook/route.ts", contains: "stripe" },
  },
  {
    id: "sentry",
    name: "Sentry",
    purpose: "Error reports, so failures can be found and fixed. Data stored in the EU (Germany).",
    data: "Technical details of an error: the page or route, browser and device details, and the request that failed.",
    privacyUrl: "https://sentry.io/privacy/",
    evidence: { file: "sentry.server.config.ts", contains: "Sentry.init" },
  },
  {
    id: "datafast",
    name: "DataFast",
    purpose: "Visitor analytics for the gettrafficfa.st website (pages viewed, referrer, country), only after you accept analytics cookies.",
    data: "Pages visited, referrer, browser and device type, approximate location derived from the IP address, and a visitor identifier stored in a cookie.",
    privacyUrl: "https://datafa.st/privacy",
    evidence: { file: "components/cookie-consent.tsx", contains: "datafa.st" },
  },
  {
    id: "google-gemini",
    name: "Google (Gemini API)",
    purpose: "AI models that analyse your site, plan and write articles and replies, generate article images, and run the sampled AI answer checks.",
    data: "The content the task needs: your site's text, your settings and facts, keywords, drafts, and the public posts a reply answers.",
    privacyUrl: "https://policies.google.com/privacy",
    evidence: { file: "lib/providers/llm/gemini.ts", contains: "generative-ai" },
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude API)",
    purpose: "AI models that write and revise articles and drafts.",
    data: "The content the task needs, as for Google Gemini above.",
    privacyUrl: "https://www.anthropic.com/legal/privacy",
    evidence: { file: "lib/providers/llm/anthropic.ts", contains: "api.anthropic.com" },
  },
  {
    id: "google-search-console",
    name: "Google (Search Console API)",
    purpose: "Reading the search performance and index status of your site, only if you connect Search Console.",
    data: "The access you grant; GetTrafficFast reads your property's clicks, impressions, positions, queries and index status.",
    privacyUrl: "https://policies.google.com/privacy",
    evidence: { file: "lib/providers/analytics/search-console.ts", contains: "webmasters.readonly" },
  },
  {
    id: "google-sign-in",
    name: "Google (Sign-In)",
    purpose: "Signing in with a Google account, if you choose it.",
    data: "Your name, email address and profile picture, as Google shares them at sign-in.",
    privacyUrl: "https://policies.google.com/privacy",
    evidence: { file: "components/sign-up-form.tsx", contains: "provider: \"google\"" },
  },
  {
    id: "youtube",
    name: "YouTube Data API (Google)",
    purpose: "Finding a relevant public video to embed in an article.",
    data: "The article's search terms. No account data.",
    privacyUrl: "https://policies.google.com/privacy",
    evidence: { file: "lib/providers/video/youtube.ts", contains: "youtube/v3/search" },
  },
  {
    id: "serper",
    name: "Serper",
    purpose: "Google search results, for keyword research, rank checks and finding public conversations.",
    data: "Search queries built from your site's keywords and topics.",
    privacyUrl: "https://serper.dev/privacy",
    evidence: { file: "lib/providers/serp/serper.ts", contains: "google.serper.dev" },
  },
  {
    id: "x",
    name: "X (official API and embeds)",
    purpose: "Finding public posts on X worth answering, reading a post you add, and reading the public numbers of replies you posted and of your own account.",
    data: "Search queries built from your site's topics, the post addresses and your public X username.",
    privacyUrl: "https://x.com/en/privacy",
    evidence: { file: "lib/providers/x/api.ts", contains: "api.x.com" },
  },
  {
    id: "unavatar",
    name: "unavatar.io",
    purpose: "Showing the profile picture of a post's author in the reply inbox. Your browser asks it directly.",
    data: "The author's platform and public username, and your browser's IP address.",
    privacyUrl: "https://unavatar.io",
    evidence: { file: "lib/providers/avatars/public.ts", contains: "unavatar.io" },
  },
];

export type PublicSourceId = "github" | "hackernews" | "stackexchange" | "devto" | "reddit";

/**
 * Public platforms read for public data (threads, their dates). Nothing of
 * the customer's account is sent to them beyond search terms.
 */
export const PUBLIC_SOURCES: readonly { id: PublicSourceId; name: string }[] = [
  { id: "reddit", name: "Reddit" },
  { id: "github", name: "GitHub" },
  { id: "hackernews", name: "Hacker News" },
  { id: "stackexchange", name: "Stack Exchange" },
  { id: "devto", name: "DEV" },
];

export type DisabledId = "openai" | "perplexity" | "reddit-api" | "resend";

/**
 * Integrations present in the code that the hosted service does not use
 * today (their opt-in variables are not set in production). Self-hosters may
 * switch them on; the hosted service lists one in SERVICE_PROVIDERS before
 * it does.
 */
export const DISABLED_INTEGRATIONS: readonly {
  id: DisabledId;
  name: string;
  evidence: { file: string; contains: string };
}[] = [
  { id: "openai", name: "OpenAI (image generation)", evidence: { file: "lib/providers/images/openai.ts", contains: "api.openai.com" } },
  { id: "perplexity", name: "Perplexity (AI answer checks)", evidence: { file: "lib/providers/citations/perplexity.ts", contains: "api.perplexity.ai" } },
  { id: "reddit-api", name: "Reddit Data API", evidence: { file: "lib/providers/discovery/reddit.ts", contains: "oauth.reddit.com" } },
  { id: "resend", name: "Resend (notification emails)", evidence: { file: "lib/notifications/email.ts", contains: "api.resend.com" } },
];

export type ModuleDisclosure =
  | { kind: "provider"; ids: ProviderId[] }
  | { kind: "source"; ids: PublicSourceId[] }
  | { kind: "disabled"; id: DisabledId }
  | { kind: "internal" };

const INTERNAL: ModuleDisclosure = { kind: "internal" };

/**
 * Every file under lib/providers, and what it means for the legal pages.
 * "internal" files call no vendor (types, registries, parsers) or call one
 * already disclosed through another file. tests/legal.test.ts fails on a
 * file missing here.
 */
export const PROVIDER_MODULES: Record<string, ModuleDisclosure> = {
  "lib/providers/http.ts": INTERNAL,
  "lib/providers/safe-fetch.ts": INTERNAL,
  "lib/providers/analytics/search-console.ts": { kind: "provider", ids: ["google-search-console"] },
  "lib/providers/analytics/types.ts": INTERNAL,
  "lib/providers/avatars/public.ts": { kind: "provider", ids: ["unavatar"] },
  "lib/providers/citations/gemini.ts": { kind: "provider", ids: ["google-gemini"] },
  "lib/providers/citations/perplexity.ts": { kind: "disabled", id: "perplexity" },
  "lib/providers/citations/registry.ts": INTERNAL,
  "lib/providers/citations/resolve.ts": INTERNAL,
  "lib/providers/citations/types.ts": INTERNAL,
  "lib/providers/discovery/canonical.ts": INTERNAL,
  "lib/providers/discovery/github.ts": { kind: "source", ids: ["github"] },
  "lib/providers/discovery/reddit-ids.ts": INTERNAL,
  "lib/providers/discovery/reddit.ts": { kind: "disabled", id: "reddit-api" },
  "lib/providers/discovery/registry.ts": INTERNAL,
  "lib/providers/discovery/types.ts": INTERNAL,
  "lib/providers/discovery/web-search.ts": { kind: "provider", ids: ["serper"] },
  "lib/providers/images/google.ts": { kind: "provider", ids: ["google-gemini"] },
  "lib/providers/images/openai.ts": { kind: "disabled", id: "openai" },
  "lib/providers/images/registry.ts": INTERNAL,
  "lib/providers/images/types.ts": INTERNAL,
  "lib/providers/llm/anthropic.ts": { kind: "provider", ids: ["anthropic"] },
  "lib/providers/llm/bound.ts": INTERNAL,
  "lib/providers/llm/fallback.ts": INTERNAL,
  "lib/providers/llm/gemini.ts": { kind: "provider", ids: ["google-gemini"] },
  "lib/providers/llm/images.ts": INTERNAL,
  "lib/providers/llm/registry.ts": INTERNAL,
  "lib/providers/llm/structured.ts": INTERNAL,
  "lib/providers/llm/types.ts": INTERNAL,
  "lib/providers/post-dates/index.ts": {
    kind: "source",
    ids: ["hackernews", "stackexchange", "devto", "reddit", "github"],
  },
  "lib/providers/serp/dates.ts": INTERNAL,
  "lib/providers/serp/registry.ts": INTERNAL,
  "lib/providers/serp/serper.ts": { kind: "provider", ids: ["serper"] },
  "lib/providers/serp/types.ts": INTERNAL,
  "lib/providers/video/registry.ts": INTERNAL,
  "lib/providers/video/types.ts": INTERNAL,
  "lib/providers/video/youtube.ts": { kind: "provider", ids: ["youtube"] },
  "lib/providers/x/api.ts": { kind: "provider", ids: ["x"] },
  "lib/providers/x/links.ts": INTERNAL,
  "lib/providers/x/oembed.ts": { kind: "provider", ids: ["x"] },
  "lib/providers/x/short-link.ts": { kind: "provider", ids: ["x"] },
  "lib/providers/x/status-time.ts": INTERNAL,
};
