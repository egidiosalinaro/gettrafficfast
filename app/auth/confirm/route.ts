import { createClient } from "@/lib/supabase/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { hasActiveSubscription } from "@/lib/subscription";
import { APP_HOME, landingAfterSignIn, safeNextPath } from "@/lib/app-home";
import { SET_PASSWORD_PATH } from "@/lib/password-login";

/**
 * Where a signed-in user goes from here: the `?next=` path when there is one,
 * else Replies for a subscriber and pricing for everyone else. The
 * subscription is only read when it decides something.
 */
async function landingFor(userId: string, next: string | null): Promise<string> {
  const explicit = safeNextPath(next);
  if (explicit) return explicit;
  return landingAfterSignIn({
    next: null,
    subscribed: await hasActiveSubscription(userId),
  });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const searchParams = url.searchParams;
  const next = searchParams.get("next");

  const supabase = await createClient();

  // Check for code parameter (magic link or OAuth callback)
  const code = searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      redirect(`/auth/error?error=${encodeURIComponent(error.message || "Authentication failed")}`);
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    redirect(user ? await landingFor(user.id, next) : (safeNextPath(next) ?? APP_HOME));
  }

  // Check for token_hash and type (alternative magic link format)
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash,
    });
    if (error) {
      redirect(`/auth/error?error=${encodeURIComponent(error.message || "Verification failed")}`);
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    redirect(user ? await landingFor(user.id, next) : (safeNextPath(next) ?? APP_HOME));
  }

  // Already signed in (an OAuth callback without a code)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect(await landingFor(user.id, next));
  }

  // A set-password link answered in the implicit flow: the session is in the
  // URL fragment, which never reaches the server. The set-password page reads
  // it (the browser carries the fragment over this redirect).
  if (safeNextPath(next) === SET_PASSWORD_PATH) {
    redirect(SET_PASSWORD_PATH);
  }

  redirect(`/auth/error?error=${encodeURIComponent("No authentication parameters provided")}`);
}
