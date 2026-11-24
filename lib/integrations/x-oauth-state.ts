import { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * The X connect round trip's state, kept in the person's browser as one
 * httpOnly cookie, sealed with AES-256-GCM under INTEGRATIONS_ENCRYPTION_KEY
 * (lib/integrations/crypto.ts): the cookie can be neither read (the PKCE
 * verifier stays secret) nor altered (GCM's tag fails), and it expires.
 *
 * It carries who started the round trip and for which site: the callback
 * attaches the account to THAT site, after checking the person signed in is
 * the same and still owns it, whatever site is selected by then.
 */

export const X_OAUTH_COOKIE = "x_oauth_state";
/** How long the person has on X's consent screen. */
export const X_OAUTH_STATE_TTL_SECONDS = 600;

const Sealed = z.object({
  state: z.string().min(16),
  verifier: z.string().min(43).max(128),
  userId: z.string().min(1),
  businessId: z.string().min(1),
  /** Unix milliseconds. */
  expiresAt: z.number(),
});
export type XOAuthState = z.infer<typeof Sealed>;

export function sealXOAuthState(state: XOAuthState): string {
  return encryptSecret(JSON.stringify(Sealed.parse(state)));
}

/** The state, or null when the cookie is missing, altered, unreadable or expired. */
export function openXOAuthState(sealed: string | null | undefined, now: Date = new Date()): XOAuthState | null {
  if (!sealed) return null;
  try {
    const parsed = Sealed.safeParse(JSON.parse(decryptSecret(sealed)));
    if (!parsed.success) return null;
    return parsed.data.expiresAt > now.getTime() ? parsed.data : null;
  } catch {
    return null;
  }
}
