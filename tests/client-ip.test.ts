import { describe, expect, it } from "vitest";
import { clientIp, trustedProxyHops } from "@/lib/client-ip";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

describe("clientIp, default (Vercel)", () => {
  const env = {};

  it("prefers Vercel's own header over anything the client could write", () => {
    expect(
      clientIp(req({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), env)
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then the leftmost x-forwarded-for", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "1.2.3.4" }), env)).toBe("203.0.113.8");
    expect(clientIp(req({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }), env)).toBe("198.51.100.1");
  });

  it("says unknown when no header names an address", () => {
    expect(clientIp(req({}), env)).toBe("unknown");
  });
});

describe("clientIp, self-hosted with TRUSTED_PROXY_HOPS", () => {
  it("reads the entry the outermost trusted proxy appended, ignoring what the client prepended", () => {
    const headers = {
      "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2",
      "x-real-ip": "6.6.6.6",
      "x-vercel-forwarded-for": "6.6.6.6",
    };
    expect(clientIp(req(headers), { TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.9");
    expect(clientIp(req(headers), { TRUSTED_PROXY_HOPS: "1" })).toBe("10.0.0.2");
  });

  it("gives unknown when the chain is shorter than the proxies in front", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }), { TRUSTED_PROXY_HOPS: "2" })).toBe("unknown");
    expect(clientIp(req({ "x-real-ip": "203.0.113.9" }), { TRUSTED_PROXY_HOPS: "1" })).toBe("unknown");
  });

  it("refuses a setting that is not a positive whole number", () => {
    expect(trustedProxyHops({})).toBeNull();
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: " " })).toBeNull();
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "3" })).toBe(3);
    for (const bad of ["0", "-1", "two", "1.5"]) {
      expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: bad })).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });
});
