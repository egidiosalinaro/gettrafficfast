import type { ApiErrorCode } from "@/lib/api-errors";

/**
 * Every error code of the API and MCP (lib/api-errors.ts) as the public MCP
 * reference states it (`/docs/mcp#errors`): the HTTP status the REST runner
 * answers with, and what it means in a line. Typed as a record over every
 * code, so a code added to API_ERROR_CODES does not type-check until it is
 * described here; tests/docs/mcp-page.test.tsx checks the list too.
 */
export const ERROR_CODE_DOCS: Readonly<Record<ApiErrorCode, { status: string; meaning: string }>> = {
  unauthorized: { status: "401", meaning: "No credential. MCP also sends WWW-Authenticate with the resource metadata, which starts sign-in." },
  invalid_api_key: { status: "401", meaning: "Not a live GetTrafficFast key." },
  revoked_api_key: { status: "401", meaning: "The key was revoked." },
  invalid_token: { status: "401", meaning: "An access token that is unknown, expired or revoked: refresh it, or connect again." },
  business_not_found: { status: "404", meaning: "x-gtf-business names a site the account does not have, or site names none of the connection's sites." },
  forbidden_business: { status: "403", meaning: "The key or connection is limited to another site." },
  forbidden_scope: { status: "403", meaning: "The key or connection lacks a permission the tool needs." },
  no_business: { status: "409", meaning: "The account has no site yet." },
  unknown_tool: { status: "404", meaning: "No tool by that name." },
  invalid_input: { status: "400", meaning: "The input does not match the tool's schema, or a value is refused." },
  not_found: { status: "404", meaning: "The id names nothing on this site." },
  invalid_state: { status: "409", meaning: "The thing exists but cannot make that move now." },
  prerequisite_missing: { status: "409", meaning: "Something must be filled in first; the hint says where." },
  confirmation_required: {
    status: "409",
    meaning: "The call would start AI work or spending and did not say confirm: true. Nothing changed: ask the person, then send it again.",
  },
  subscription_required: {
    status: "402",
    meaning: "The account has no active plan. Every tool answers this until it has one.",
  },
  cap_reached: { status: "429", meaning: "A daily cap of the key, the connection or the account is reached (409 when creating a key over the key limit)." },
  spend_cap_reached: { status: "429", meaning: "Today's limit for AI work is reached; it resets on its own and the message says when." },
  rate_limited: { status: "429", meaning: "Too many calls in the last minute; Retry-After says when to come back." },
  unavailable: { status: "503", meaning: "A provider is paused or did not answer, or a limit could not be checked. Nothing changed." },
  delivery_failed: { status: "502", meaning: "Your own site (its publishing destination) refused the article." },
  internal: { status: "500", meaning: "A failure on our side. It was logged." },
};
