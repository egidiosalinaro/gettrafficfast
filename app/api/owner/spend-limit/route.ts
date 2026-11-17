import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformOwner } from "@/lib/owner";
import { OwnerSpendLimitInput, saveDailySpendLimit } from "@/lib/limits/settings";

/**
 * /settings/costs: a platform owner sets an account's daily AI spend ceiling.
 *
 * Body: `{ userId, dailySpendUsd, confirm? }`. $1 to $100, to the cent.
 * Lowering applies at once; raising needs `confirm: true` (the screen's
 * second tap), else 409 `confirmation_required` and nothing changes.
 *
 * Anyone who is not an owner (lib/owner.ts) gets the same 404 a path that
 * does not exist gets, signed out included: nothing says this route is here.
 * Session only: this route reads the cookie and nothing else, so no API key
 * reaches it and a leaked key, even an owner's, can never raise a ceiling.
 * The write is the service role's, after the owner check: customers have no
 * write policy on `account_limits` (migration 20261114140000).
 */

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformOwner(user.id)) return notFound();

  const body = await request.json().catch(() => null);
  const parsed = OwnerSpendLimitInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input.", code: "invalid_input" },
      { status: 400 }
    );
  }

  const { userId, dailySpendUsd, confirm } = parsed.data;
  const saved = await saveDailySpendLimit({
    supabase: createAdminClient(),
    userId,
    input: { dailySpendUsd, confirm },
  });
  if (!saved.ok) return NextResponse.json({ error: saved.error, code: saved.code }, { status: saved.status });

  console.info(
    JSON.stringify({
      level: "info",
      event: "spend_limit.set_by_owner",
      owner_id: user.id,
      user_id: userId,
      from_usd: saved.previousUsd,
      to_usd: saved.ceiling.usd,
    })
  );
  return NextResponse.json({ userId, dailySpendUsd: saved.ceiling.usd, previousUsd: saved.previousUsd });
}
