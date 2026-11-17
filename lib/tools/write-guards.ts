import { z } from "zod";
import type { ApiKeyScope } from "@/lib/api-keys";
import { HINTS } from "@/lib/api-errors";
import { loadSiteSettings } from "@/lib/business/save-settings";
import { ToolError, type ToolContext } from "./tool";

/**
 * What the write tools share: the `confirm` field, the extra scopes a change
 * needs when it switches spending on, and the mapping of a lib function's
 * `{ status, error }` refusal to the API's error.
 *
 * The runner checks a tool's own scopes before anything runs. A few changes
 * need more than the tool's scope only for one value of the input (turning
 * autopilot on, not off), so the handler asks here, before it reads or
 * writes anything.
 */

export const Confirm = z
  .boolean()
  .default(false)
  .describe(
    "true once the person agreed to what the call starts. Without it, a call that would start AI work (a run now, or work that goes on by itself) is refused with confirmation_required and a hint saying what it would do."
  );

/** Refuses with 403 `forbidden_scope` unless the credential holds every one of `scopes`. */
export function requireScopes(ctx: ToolContext, scopes: readonly ApiKeyScope[], what: string): void {
  const missing = scopes.filter((scope) => !ctx.caller.scopes.includes(scope));
  if (missing.length === 0) return;
  throw new ToolError(
    "forbidden_scope",
    `${what} needs a key with the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}.`,
    403,
    HINTS.keys
  );
}

/**
 * Refuses with 409 `confirmation_required` unless `confirm` is true. `message`
 * says what is being turned on and what it will ask or make, never a price;
 * `hint` how to go ahead.
 */
export function requireConfirmation(confirm: boolean, message: string, hint: string): void {
  if (!confirm) throw new ToolError("confirmation_required", message, 409, hint);
}

/**
 * A lib function's refusal as the API's error. A 500 is thrown as a plain
 * error, so the runner logs the detail and answers its own sentence: a
 * database message never reaches the caller.
 */
export function libRefusal(result: { status: number; error: string }): Error {
  switch (result.status) {
    case 400:
      return new ToolError("invalid_input", result.error, 400);
    case 404:
      return new ToolError("not_found", result.error, 404);
    case 409:
      return new ToolError("invalid_state", result.error, 409);
    case 429:
      return new ToolError("cap_reached", result.error, 429, HINTS.caps);
    case 503:
      return new ToolError("unavailable", result.error, 503);
    default:
      return new Error(result.error);
  }
}

// ── Partial settings changes ─────────────────────────────────────────────────

/**
 * A settings schema's fields, each optional and without its default: what a
 * partial change looks like. The route takes the whole object (a missing
 * field is its default); a tool takes only what changes, so an agent that
 * sends `{ enabled: true }` does not reset the rest.
 */
export function partialOf<S extends z.ZodRawShape>(shape: S) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => {
      const inner = schema instanceof z.ZodDefault ? schema.unwrap() : schema;
      return [key, (inner as z.ZodType).optional()];
    })
  ) as unknown as { [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer T> ? T : S[K]> };
}

/** The fields a partial input names, without `confirm` and the ones left out. */
export function changesOf(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "confirm" && value !== undefined));
}

/** The merged settings through the route's strict schema; 400 `invalid_input` when they do not pass. */
export function strictSettings<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ToolError(
      "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; "),
      400
    );
  }
  return parsed.data;
}

/** The site's stored settings, to merge a change onto; 404 when the site is gone. */
export async function storedSettings(ctx: ToolContext) {
  const stored = await loadSiteSettings(ctx.client, ctx.userId, ctx.businessId);
  if (!stored) throw new ToolError("not_found", "This site is no longer on the account.", 404);
  return stored;
}
