import type { NextRequest } from "next/server";

/** Short-lived CSRF state for the Google consent round trip. */
export const OAUTH_STATE_COOKIE = "gsc_oauth_state";

/**
 * The redirect URI, which must match a value registered in the Google Cloud
 * console character for character. Derived from the request so preview and
 * production deployments each use their own, as long as both are registered.
 */
export function redirectUriFor(request: NextRequest): string {
  return `${request.nextUrl.origin}/api/integrations/search-console/callback`;
}

export const SETTINGS_PATH = "/settings/integrations/search-console";
