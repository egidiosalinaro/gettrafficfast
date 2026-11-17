import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelation } from "@/lib/supabase/errors";
import {
  ACCOUNT_LIMITS_TABLE,
  MAX_DAILY_SPEND_USD,
  MIN_DAILY_SPEND_USD,
  SpendUnreadable,
  formatLimitUsd,
  readDailySpendCeiling,
  type SpendCeiling,
} from "./spend";

/**
 * /settings/costs: a platform owner (lib/owner.ts) sets an account's daily
 * AI spend ceiling (lib/limits/spend.ts), $1 to $100, to the cent. The
 * customer no longer sets it (the owner's decision, 2026-11-13): it protects
 * the platform's model credits, and a subscriber never sees it in dollars.
 *
 * Lowering it takes effect at once. Raising it lets more money through, so
 * it is never one tap: the screen asks a second time in place (the inline
 * confirm), and the route refuses a raise that does not say `confirm: true`
 * (409 `confirmation_required`), so the rule holds for a direct POST too.
 * The bounds are also a check constraint on `account_limits`.
 *
 * The write goes through the service role, after the route checked the
 * owner: since migration 20261114140000 RLS lets no customer insert or
 * update a row, so a customer cannot set his own ceiling by any door. Only a
 * signed-in session reaches the route; an API key cannot, on purpose, so a
 * leaked key, even an owner's, can never raise a ceiling.
 */

function hasAtMostCents(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

const AMOUNT_MESSAGE = `Enter an amount between ${formatLimitUsd(MIN_DAILY_SPEND_USD)} and ${formatLimitUsd(MAX_DAILY_SPEND_USD)}.`;

export const DailySpendLimitAmount = z
  .number({ error: AMOUNT_MESSAGE })
  .refine((value) => Number.isFinite(value), AMOUNT_MESSAGE)
  .refine((value) => value >= MIN_DAILY_SPEND_USD, `The daily limit is at least ${formatLimitUsd(MIN_DAILY_SPEND_USD)}.`)
  .refine((value) => value <= MAX_DAILY_SPEND_USD, `The daily limit is at most ${formatLimitUsd(MAX_DAILY_SPEND_USD)}.`)
  .refine(hasAtMostCents, "Use dollars and cents, at most two decimals.");

export const DailySpendLimitInput = z.object({
  dailySpendUsd: DailySpendLimitAmount,
  /** Required to raise the limit: the second tap. */
  confirm: z.boolean().optional(),
});

/** What a person typed ("20", "$7.50", " 15 ") as an amount, or why not. */
export function parseSpendLimit(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim().replace(/^\$/, "").trim();
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: AMOUNT_MESSAGE };
  const parsed = DailySpendLimitAmount.safeParse(Number(text));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? AMOUNT_MESSAGE };
  return { ok: true, value: parsed.data };
}

/** The question the second tap answers. */
export function raiseQuestion(fromUsd: number, toUsd: number): string {
  return `Raise this account's daily AI spend ceiling from ${formatLimitUsd(fromUsd)} to ${formatLimitUsd(toUsd)}? Up to ${formatLimitUsd(toUsd)} of model cost can then be spent on it in any 24 hours.`;
}

/** The owner's request: whose ceiling, the amount, and the second tap. */
export const OwnerSpendLimitInput = DailySpendLimitInput.extend({
  userId: z.string().uuid("Name the account by its user id."),
});

export type SaveSpendLimitResult =
  | { ok: true; ceiling: SpendCeiling; previousUsd: number }
  | {
      ok: false;
      status: 400 | 409 | 500 | 503;
      code: "invalid_input" | "confirmation_required" | "unavailable" | "internal";
      error: string;
    };

/**
 * Validates and stores `userId`'s ceiling. `supabase` is the service role:
 * customers have no write policy on `account_limits`, so the caller (the
 * owner's route) must have checked `isPlatformOwner` first. A raise without
 * `confirm` changes nothing.
 */
export async function saveDailySpendLimit(params: {
  supabase: SupabaseClient;
  /** The account whose ceiling changes. */
  userId: string;
  input: unknown;
  now?: Date;
}): Promise<SaveSpendLimitResult> {
  const parsed = DailySpendLimitInput.safeParse(params.input);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "invalid_input", error: parsed.error.issues[0]?.message ?? AMOUNT_MESSAGE };
  }
  const { dailySpendUsd, confirm } = parsed.data;

  let current: SpendCeiling;
  try {
    current = await readDailySpendCeiling(params.supabase, params.userId);
  } catch (error) {
    const detail = error instanceof SpendUnreadable ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", event: "spend_limit.read_failed", user_id: params.userId, error: detail.slice(0, 300) }));
    return { ok: false, status: 503, code: "unavailable", error: "The current limit could not be read, so nothing was changed. Try again in a minute." };
  }

  if (dailySpendUsd > current.usd && confirm !== true) {
    return { ok: false, status: 409, code: "confirmation_required", error: raiseQuestion(current.usd, dailySpendUsd) };
  }

  const { error } = await params.supabase.from(ACCOUNT_LIMITS_TABLE).upsert(
    {
      user_id: params.userId,
      daily_spend_usd: dailySpendUsd,
      updated_at: (params.now ?? new Date()).toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    if (isMissingRelation(error)) {
      return { ok: false, status: 503, code: "unavailable", error: "The daily limit cannot be changed yet. The default applies for now; try again later." };
    }
    console.error(JSON.stringify({ level: "error", event: "spend_limit.save_failed", user_id: params.userId, error: String(error.message).slice(0, 300) }));
    return { ok: false, status: 500, code: "internal", error: "The limit could not be saved. Try again." };
  }
  return { ok: true, ceiling: { usd: dailySpendUsd, source: "account" }, previousUsd: current.usd };
}
