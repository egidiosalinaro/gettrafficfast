import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

/**
 * The one error shape of the API (`/api/v1/*`, `/api/api-keys`) and MCP:
 *
 *   { "error": { "code": "cap_reached", "message": "…", "hint": "…" } }
 *
 * `code` is stable and machine-readable: an agent branches on it. `message`
 * is the sentence the screens show for the same case. `hint`, when there is
 * one, says what to do next (a settings page, a scope to add).
 */

export const API_ERROR_CODES = [
  /** No credential, or the session expired. 401. */
  "unauthorized",
  /** A Bearer token that is not a live GetTrafficFast key. 401. */
  "invalid_api_key",
  /** A key that was revoked. 401. */
  "revoked_api_key",
  /**
   * An OAuth access token that is unknown, expired, revoked, issued for
   * another resource, or sent somewhere other than the MCP endpoint. 401;
   * the MCP endpoint's `WWW-Authenticate` says where to get a new one.
   */
  "invalid_token",
  /** `x-gtf-business` names a site the account does not have. 404. */
  "business_not_found",
  /** The site exists but this key is limited to another one. 403. */
  "forbidden_business",
  /** The key lacks the scope the tool needs (read, write, spend, publish). 403. */
  "forbidden_scope",
  /** The account has no site yet. 409. */
  "no_business",
  /** No tool by that name. 404. */
  "unknown_tool",
  /** The input does not match the tool's schema. 400. */
  "invalid_input",
  /** The id names nothing on this site. 404. */
  "not_found",
  /** The thing exists but cannot make that move now (a dismissed post marked as posted). 409. */
  "invalid_state",
  /** Something must be filled in first (Settings → Voice → About you). 409. */
  "prerequisite_missing",
  /**
   * The call would start spending (a visibility run, a cadence, autopilot,
   * images) and did not say `confirm: true`. Nothing was changed; the hint
   * says what will happen. 409.
   */
  "confirmation_required",
  /**
   * The account has no active plan (none, ended, cancelled, unpaid): every
   * tool answers this, one sentence (`PLAN_REQUIRED_MESSAGE`,
   * lib/paid-access.ts). 402.
   */
  "subscription_required",
  /** A daily cap, or the key limit, is reached. 429 (409 for keys). */
  "cap_reached",
  /** The account's daily limit for AI work is reached (the code keeps its old name). 429; resets on its own. */
  "spend_cap_reached",
  /** This key made too many calls in the last minute. 429, with Retry-After. */
  "rate_limited",
  /** A provider is paused or did not answer; nothing was changed. 503. */
  "unavailable",
  /** The customer's own site (a publishing destination) refused the delivery. 502. */
  "delivery_failed",
  /** A failure on our side; it was logged. 500. */
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  hint?: string;
}

export function apiError(code: ApiErrorCode, message: string, hint?: string): ApiError {
  return hint ? { code, message, hint } : { code, message };
}

export function apiErrorResponse(status: number, error: ApiError, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

/** Where a person fixes the thing a hint names. */
export const HINTS = {
  aboutYou: `Say how you use the product in Settings → Voice → About you: ${SITE_URL}/settings/voice.`,
  addSite: `Add your site first: ${SITE_URL}/settings/business.`,
  keys: `Create or change keys in Settings → Claude and API: ${SITE_URL}/settings/api-keys.`,
  connectedApps: `Connected apps are listed, and revoked, in Settings → Claude and API: ${SITE_URL}/settings/api-keys.`,
  caps: "Daily caps count a rolling 24 hours; they open up again within a day.",
  keyCaps: `Per-key daily caps count a rolling 24 hours and open up again within a day; the docs list them: ${SITE_URL}/docs#limits.`,
  accountCaps: `Account daily caps count every key and the screens over a rolling 24 hours, and open up again within a day; the docs list them: ${SITE_URL}/docs#limits.`,
  spendCap: `The daily limit for AI work counts a rolling 24 hours and opens up again on its own. Settings → Plan shows what your plan includes and what is used: ${SITE_URL}/settings/billing.`,
  rateLimit: "Wait a minute and call again: a key may make 60 calls a minute, whatever the tool.",
  integrations: `Connect or fix the site's destination in Settings → Connections: ${SITE_URL}/settings/integrations.`,
} as const;
