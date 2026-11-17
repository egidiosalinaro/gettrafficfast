import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "@/lib/cron-auth";

function request(authorization?: string) {
  return new Request("https://gettrafficfa.st/api/cron/x", {
    headers: authorization ? { authorization } : {},
  });
}

describe("isCronAuthorized", () => {
  it("accepts the configured bearer secret", () => {
    expect(isCronAuthorized(request("Bearer s3cret"), "s3cret")).toBe(true);
  });

  it("refuses a wrong secret, one of another length, a missing header and another scheme", () => {
    expect(isCronAuthorized(request("Bearer s3creT"), "s3cret")).toBe(false);
    expect(isCronAuthorized(request("Bearer s3cret-and-more"), "s3cret")).toBe(false);
    expect(isCronAuthorized(request("Bearer "), "s3cret")).toBe(false);
    expect(isCronAuthorized(request(), "s3cret")).toBe(false);
    expect(isCronAuthorized(request("Basic s3cret"), "s3cret")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(isCronAuthorized(request("Bearer "), undefined)).toBe(false);
    expect(isCronAuthorized(request("Bearer "), "")).toBe(false);
    expect(isCronAuthorized(request("Bearer undefined"), undefined)).toBe(false);
  });

  it("reads CRON_SECRET from the environment by default", () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "from-env";
    try {
      expect(isCronAuthorized(request("Bearer from-env"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
