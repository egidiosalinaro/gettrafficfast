import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isPasswordLoginEmail, MIN_PASSWORD_LENGTH } from "@/lib/password-login";

/**
 * Sets the signed-in account's password, from the set-password page the
 * reviewer-account email opens (app/auth/set-password, docs/API.md "The
 * reviewer account").
 *
 * Only for an address on PASSWORD_LOGIN_EMAILS: everyone else signs in with
 * the emailed link or Google, and an account that is not on the list gets
 * the same 404 a missing route gets. Session only (the recovery link's
 * session); the password goes to Supabase and is never logged or stored
 * here.
 */

const Body = z.object({
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(128, "Use at most 128 characters."),
});

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPasswordLoginEmail(user.email)) return notFound();

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid password." }, { status: 400 });
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  console.info(JSON.stringify({ level: "info", event: "password.set", user_id: user.id }));
  return NextResponse.json({ ok: true });
}
