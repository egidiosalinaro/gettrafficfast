import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  asksForPassword,
  isPasswordLoginEmail,
  LookupLimiter,
  looksLikeEmail,
  passwordLoginEmails,
  recoverySessionFromHash,
  SIGN_IN_METHOD_ROUTE,
} from "@/lib/password-login";

/**
 * Password sign-in for the addresses on PASSWORD_LOGIN_EMAILS only
 * (lib/password-login.ts). What is pinned: the list fails closed and is
 * case-insensitive; the lookup route answers a bare yes or no from the list
 * alone (never the list, never whether an account exists) and is
 * rate-limited; the browser helper treats anything but a clear yes as no,
 * so every other address keeps the emailed link.
 */

const REVIEWER = "reviewer+gtf@example.com";

describe("the list", () => {
  it("fails closed: unset, empty or blank lists nobody", () => {
    for (const env of [{}, { PASSWORD_LOGIN_EMAILS: "" }, { PASSWORD_LOGIN_EMAILS: " , ," }]) {
      expect(passwordLoginEmails(env)).toEqual([]);
      expect(isPasswordLoginEmail(REVIEWER, env)).toBe(false);
    }
  });

  it("matches case-insensitively, spaces around the commas included", () => {
    const env = { PASSWORD_LOGIN_EMAILS: ` Other@Example.com , ${REVIEWER.toUpperCase()} ` };
    expect(passwordLoginEmails(env)).toEqual(["other@example.com", REVIEWER]);
    expect(isPasswordLoginEmail(REVIEWER, env)).toBe(true);
    expect(isPasswordLoginEmail(`  ${REVIEWER.toUpperCase()} `, env)).toBe(true);
  });

  it("never matches a missing, empty or partial address", () => {
    const env = { PASSWORD_LOGIN_EMAILS: REVIEWER };
    expect(isPasswordLoginEmail(null, env)).toBe(false);
    expect(isPasswordLoginEmail("", env)).toBe(false);
    expect(isPasswordLoginEmail("reviewer@example.com", env)).toBe(false);
    expect(isPasswordLoginEmail(`${REVIEWER}x`, env)).toBe(false);
  });
});

describe("LookupLimiter", () => {
  it("allows the limit per window, per caller, then refuses until the window ends", () => {
    const limiter = new LookupLimiter(3, 1000);
    expect([1, 2, 3].map(() => limiter.allow("a", 0))).toEqual([true, true, true]);
    expect(limiter.allow("a", 500)).toBe(false);
    expect(limiter.allow("b", 500)).toBe(true);
    expect(limiter.allow("a", 1000)).toBe(true);
  });

  it("stays bounded in memory", () => {
    const limiter = new LookupLimiter(1, 1000, 3);
    for (const key of ["a", "b", "c", "d", "e"]) expect(limiter.allow(key, 0)).toBe(true);
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
});

describe("recoverySessionFromHash", () => {
  it("reads the implicit flow's session, and nothing else", () => {
    expect(recoverySessionFromHash("#access_token=a&refresh_token=r&type=recovery")).toEqual({
      access_token: "a",
      refresh_token: "r",
    });
    expect(recoverySessionFromHash("#error=access_denied&error_description=expired")).toBeNull();
    expect(recoverySessionFromHash("")).toBeNull();
  });
});

describe("asksForPassword (the form's question)", () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("is true only on a clear yes from the route", async () => {
    const yes = answer(200, { password: true });
    expect(await asksForPassword(REVIEWER, yes)).toBe(true);
    expect(yes).toHaveBeenCalledWith(SIGN_IN_METHOD_ROUTE, expect.objectContaining({ method: "POST" }));
    expect(await asksForPassword(REVIEWER, answer(200, { password: false }))).toBe(false);
    expect(await asksForPassword(REVIEWER, answer(200, { password: "true" }))).toBe(false);
    expect(await asksForPassword(REVIEWER, answer(429, { error: "slow down" }))).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await asksForPassword(REVIEWER, broken)).toBe(false);
  });

  it("does not ask about something that is not an address yet", async () => {
    const fetchImpl = answer(200, { password: true });
    expect(looksLikeEmail("reviewer@exa")).toBe(false);
    expect(await asksForPassword("reviewer@exa", fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/sign-in-method", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PASSWORD_LOGIN_EMAILS", REVIEWER);
  });
  afterEach(() => vi.unstubAllEnvs());

  const ask = async (route: { POST: (r: NextRequest) => Promise<Response> }, email: unknown, ip = "203.0.113.7") => {
    const request = new Request("https://gettrafficfa.st/api/auth/sign-in-method", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email }),
    }) as unknown as NextRequest;
    const res = await route.POST(request);
    return { status: res.status, body: await res.json() };
  };

  it("answers yes for a listed address and the same bare no for every other one", async () => {
    const route = await import("@/app/api/auth/sign-in-method/route");
    expect(await ask(route, REVIEWER.toUpperCase())).toEqual({ status: 200, body: { password: true } });
    const unlisted = await ask(route, "someone@example.com");
    const nobody = await ask(route, "nobody-has-this@example.com");
    expect(unlisted).toEqual({ status: 200, body: { password: false } });
    expect(nobody).toEqual(unlisted);
    // The list itself is never in an answer.
    expect(JSON.stringify(unlisted)).not.toContain(REVIEWER);
  });

  it("refuses a caller past the limit with 429", async () => {
    const route = await import("@/app/api/auth/sign-in-method/route");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await ask(route, `guess${i}@example.com`, "198.51.100.9")).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    // Another caller is not affected.
    expect((await ask(route, REVIEWER, "198.51.100.10")).status).toBe(200);
  });

  it("answers 400 to a body without an email", async () => {
    const route = await import("@/app/api/auth/sign-in-method/route");
    expect((await ask(route, 42)).status).toBe(400);
  });
});
