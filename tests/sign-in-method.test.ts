import { describe, expect, it } from "vitest";
import type { User } from "@supabase/supabase-js";
import { signInMethod } from "@/lib/sign-in-method";

/**
 * The Account page said every email was "managed through your OAuth provider
 * (Google)", which is false for an account that signs in with the emailed
 * link. It now says which of the two is true.
 */

type AuthRecord = Pick<User, "app_metadata" | "identities">;

const record = (provider: string, identities: string[] = []): AuthRecord => ({
  app_metadata: { provider, providers: [provider] },
  identities: identities.map((p) => ({ provider: p }) as NonNullable<User["identities"]>[number]),
});

describe("signInMethod", () => {
  it("is Google when the account has a Google identity", () => {
    expect(signInMethod(record("google", ["google"]))).toBe("google");
    expect(signInMethod(record("email", ["email", "google"]))).toBe("google");
  });

  it("is the emailed link otherwise", () => {
    expect(signInMethod(record("email", ["email"]))).toBe("email");
    expect(signInMethod({ app_metadata: {}, identities: [] })).toBe("email");
    expect(signInMethod(null)).toBe("email");
  });
});
