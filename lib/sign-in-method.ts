import type { User } from "@supabase/supabase-js";

/**
 * How an account signs in, from its auth record: Google when Supabase holds a
 * Google identity for it, the emailed link otherwise. Those are the only two
 * ways in (components/sign-up-form.tsx), so the Account page can say which
 * one is true instead of assuming Google for everyone.
 */
export function signInMethod(
  user: Pick<User, "app_metadata" | "identities"> | null
): "google" | "email" {
  const providers = new Set<string>();
  const metadata = user?.app_metadata as { provider?: unknown; providers?: unknown } | undefined;
  if (typeof metadata?.provider === "string") providers.add(metadata.provider);
  if (Array.isArray(metadata?.providers)) {
    for (const provider of metadata.providers) {
      if (typeof provider === "string") providers.add(provider);
    }
  }
  for (const identity of user?.identities ?? []) providers.add(identity.provider);
  return providers.has("google") ? "google" : "email";
}
