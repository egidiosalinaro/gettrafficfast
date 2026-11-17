/**
 * Password sign-in, for a short list of addresses only (docs/API.md "The
 * reviewer account").
 *
 * Everyone signs in with the emailed link or Google. The MCP directory
 * reviewers (Anthropic, OpenAI) need a permanent account they can open with
 * an email and a password, no 2FA and no inbox, so the addresses listed in
 * `PASSWORD_LOGIN_EMAILS` (comma-separated, case-insensitive, set on Vercel)
 * get a password field on the sign-in form once their address is typed.
 *
 * The list never reaches the browser. The form asks
 * `POST /api/auth/sign-in-method` about the one address typed, and the
 * answer is a yes or a no that depends on the list alone: no account is
 * looked up, so for any address not on the list the answer is the same "no"
 * whether an account exists or not (no enumeration), and the form behaves
 * exactly as before. The route is rate-limited per caller.
 *
 * Fail closed: unset, empty, or a list of blanks means nobody gets a
 * password field.
 */

export const PASSWORD_LOGIN_ENV = "PASSWORD_LOGIN_EMAILS";

/**
 * Where the set-password email lands (app/auth/set-password). Public, since
 * the recovery link may arrive with its session in the URL fragment, before
 * any cookie exists.
 */
export const SET_PASSWORD_PATH = "/auth/set-password";

/** A password on this list is a shared credential for reviewers: long, not clever. */
export const MIN_PASSWORD_LENGTH = 12;

/** An address as compared: trimmed, lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The listed addresses, normalized; empty when none. */
export function passwordLoginEmails(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[PASSWORD_LOGIN_ENV];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map(normalizeEmail)
    .filter((email) => email.length > 0);
}

/** True only when `email` is on the list. */
export function isPasswordLoginEmail(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof email !== "string") return false;
  const wanted = normalizeEmail(email);
  if (!wanted) return false;
  return passwordLoginEmails(env).includes(wanted);
}

/**
 * The session a recovery link carries in its URL fragment, when Supabase
 * answers in the implicit flow (`#access_token=…&refresh_token=…&type=recovery`).
 * Null for anything else, including an error fragment.
 */
export function recoverySessionFromHash(hash: string): { access_token: string; refresh_token: string } | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token };
}

/** Enough of an address to be worth asking about: something@something.tld, no spaces. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export const SIGN_IN_METHOD_ROUTE = "/api/auth/sign-in-method";

/**
 * The form's question, from the browser: true only when the route answers
 * `{ password: true }`. Anything else (a no, a 429, a network error, a
 * malformed body) is false, so the form keeps the emailed link it always had.
 */
export async function asksForPassword(email: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!looksLikeEmail(email)) return false;
  try {
    const res = await fetchImpl(SIGN_IN_METHOD_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { password?: unknown } | null;
    return body?.password === true;
  } catch {
    return false;
  }
}

/** Lookups one caller may make in a window. Typing an address takes a few; guessing the list takes many. */
export const SIGN_IN_METHOD_LOOKUPS_PER_WINDOW = 20;
export const SIGN_IN_METHOD_WINDOW_MS = 10 * 60 * 1000;

/**
 * A fixed-window counter per caller, in memory. Per server instance, so it
 * is a brake rather than a wall; that is enough here, because the only thing
 * a lookup can reveal is whether one address is on a list of test accounts,
 * and a correct guess still needs that account's password.
 */
export class LookupLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = SIGN_IN_METHOD_LOOKUPS_PER_WINDOW,
    private readonly windowMs = SIGN_IN_METHOD_WINDOW_MS,
    private readonly maxKeys = 10_000
  ) {}

  /** True when `key` may make one more lookup now (and counts it). */
  allow(key: string, now: number = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
    // Still full: forget the oldest rather than grow without bound.
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}
