/**
 * Consent for the analytics cookies of this website (docs/DATAFAST.md).
 *
 * The visitor analytics script sets third-party-provided cookies, which under
 * EU and Italian rules (Garante, guidelines of 10 June 2021) need consent
 * before they are set. So the script loads only after the visitor accepts;
 * no choice and "Reject" both mean no script. The choice is kept in this
 * browser for six months, and is not asked again before then unless
 * CONSENT_VERSION changes (a new analytics tool, a new purpose).
 *
 * Pure logic here, no React: the banner (components/cookie-consent.tsx) and
 * the "Cookie settings" link use it, and tests/site/cookie-consent.test.ts
 * holds it. Every storage access is wrapped: a private window, blocked site
 * data or a full quota reads as "no choice yet", never as a crash.
 */

export type ConsentChoice = "granted" | "denied";

/** The localStorage key the choice is kept under. */
export const CONSENT_STORAGE_KEY = "gtf-cookie-consent";

/** Raise to ask everyone again (something the visitor agreed to changed). */
export const CONSENT_VERSION = 1;

/** How long a choice holds: the Garante's six months. */
export const CONSENT_MAX_AGE_MONTHS = 6;

/** Fired on window by the "Cookie settings" links; the banner reopens. */
export const OPEN_COOKIE_SETTINGS_EVENT = "gtf:open-cookie-settings";

/** The cookies the analytics script sets start with this. */
export const ANALYTICS_COOKIE_PREFIX = "datafast_";

/**
 * The analytics property of this deployment, or null when it has none. No
 * id: no script, no banner, no "Cookie settings" link. Read at call time so
 * tests can set it; Next inlines NEXT_PUBLIC_ variables at build.
 */
export function analyticsWebsiteId(): string | null {
  const id = (process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID ?? "").trim();
  return id || null;
}

/** The part of the Storage interface this module uses. */
export type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

interface StoredConsent {
  v: number;
  choice: ConsentChoice;
  /** ISO time the choice was made. */
  at: string;
}

/** When a choice made at `at` stops holding. */
export function consentExpiry(at: Date): Date {
  const expiry = new Date(at.getTime());
  expiry.setUTCMonth(expiry.getUTCMonth() + CONSENT_MAX_AGE_MONTHS);
  return expiry;
}

/**
 * The stored value, read back. Anything unreadable, from another version,
 * expired, or dated in the future is "no choice" (null): the banner asks.
 */
export function parseConsent(raw: string | null | undefined, now: Date = new Date()): ConsentChoice | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { v, choice, at } = value as Partial<StoredConsent>;
  if (v !== CONSENT_VERSION) return null;
  if (choice !== "granted" && choice !== "denied") return null;
  if (typeof at !== "string") return null;
  const made = new Date(at);
  if (Number.isNaN(made.getTime())) return null;
  if (made.getTime() > now.getTime()) return null;
  if (now.getTime() >= consentExpiry(made).getTime()) return null;
  return choice;
}

export function serializeConsent(choice: ConsentChoice, now: Date = new Date()): string {
  const value: StoredConsent = { v: CONSENT_VERSION, choice, at: now.toISOString() };
  return JSON.stringify(value);
}

/** The visitor's current choice, or null when there is none (or no storage). */
export function readConsent(storage: ConsentStorage | null | undefined, now: Date = new Date()): ConsentChoice | null {
  if (!storage) return null;
  try {
    return parseConsent(storage.getItem(CONSENT_STORAGE_KEY), now);
  } catch {
    return null;
  }
}

/** Keeps the choice. False when the browser refused to store it. */
export function writeConsent(
  storage: ConsentStorage | null | undefined,
  choice: ConsentChoice,
  now: Date = new Date(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CONSENT_STORAGE_KEY, serializeConsent(choice, now));
    return true;
  } catch {
    return false;
  }
}

/** window.localStorage, or null where reading it throws. */
export function browserStorage(): ConsentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** What the banner shows and whether the analytics script may load. */
export interface ConsentState {
  /** False until the stored choice has been read on the client. */
  ready: boolean;
  choice: ConsentChoice | null;
  /** The banner is visible. */
  open: boolean;
}

export type ConsentAction =
  | { type: "loaded"; choice: ConsentChoice | null }
  | { type: "accept" }
  | { type: "reject" }
  | { type: "reopen" };

export const INITIAL_CONSENT_STATE: ConsentState = { ready: false, choice: null, open: false };

export function consentReducer(state: ConsentState, action: ConsentAction): ConsentState {
  switch (action.type) {
    case "loaded":
      // No stored choice: ask. A stored one: stay out of the way.
      return { ready: true, choice: action.choice, open: action.choice === null };
    case "accept":
      return { ready: true, choice: "granted", open: false };
    case "reject":
      return { ready: true, choice: "denied", open: false };
    case "reopen":
      return { ...state, ready: true, open: true };
  }
}

/** The analytics script loads only on an explicit, current "granted". */
export function analyticsAllowed(state: ConsentState): boolean {
  return state.ready && state.choice === "granted";
}

/** Asks the banner to reopen, from a "Cookie settings" link anywhere. */
export function openCookieSettings(target: EventTarget | null = typeof window === "undefined" ? null : window): void {
  target?.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT));
}

/**
 * The analytics cookies present in a `document.cookie` string. Used when a
 * visitor who had accepted rejects: their cookies are deleted.
 */
export function analyticsCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter((name) => name.startsWith(ANALYTICS_COOKIE_PREFIX));
}

/**
 * The `document.cookie` assignments that expire one cookie, on this host and
 * on its parent domains (the script may set them on the registrable domain).
 */
export function expireCookieAssignments(name: string, hostname: string): string[] {
  const labels = hostname.split(".");
  const domains: (string | null)[] = [null];
  for (let i = 0; i < labels.length - 1; i++) domains.push(labels.slice(i).join("."));
  return domains.map(
    (domain) =>
      `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? `; domain=${domain}` : ""}`,
  );
}
