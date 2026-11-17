import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isPasswordLoginEmail, LookupLimiter } from "@/lib/password-login";

/**
 * How the sign-in form signs this address in: `{ password: true }` for an
 * address on PASSWORD_LOGIN_EMAILS (the directory reviewers' account,
 * lib/password-login.ts), `{ password: false }` for every other one.
 *
 * Signed out by design (the form is), and it reads nothing but the
 * environment: no account is looked up, so the answer for an unlisted
 * address is the same whether it has an account or not, and the list itself
 * is never sent. Rate-limited per caller; past the limit the answer is 429
 * and the form falls back to the emailed link, as it always did.
 */

const limiter = new LookupLimiter();

const Body = z.object({ email: z.string().max(320) });

function callerKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  if (!limiter.allow(callerKey(request))) {
    return NextResponse.json({ error: "Too many lookups. Try again later." }, { status: 429, headers: noStore });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send an email." }, { status: 400, headers: noStore });
  }
  return NextResponse.json({ password: isPasswordLoginEmail(parsed.data.email) }, { headers: noStore });
}
