import { createHmac } from "crypto";
import { describe, expect, it, vi } from "vitest";
const sent = vi.hoisted(() => ({ calls: [] as Array<[string, RequestInit]> }));
vi.mock("@/lib/providers/safe-fetch", () => ({
  BlockedAddressError: class extends Error {},
  safeFetch: async (url: string, init: RequestInit) => {
    sent.calls.push([url, init]);
    return new Response("{}", { status: 200 });
  },
}));

import { WebhookAdapter } from "@/lib/publishing/adapters/webhook";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  signatureHeaders,
  signTimestamped,
  verifyTimestamped,
} from "@/lib/publishing/webhook-signature";

/**
 * The signature contract customers' receivers implement. v1 (X-Signature,
 * body only) must stay byte-for-byte what it was, or every receiver not yet
 * moved stops verifying; v2 must bind the timestamp, or a replay verifies.
 */

const SECRET = "shhh";
const BODY = '{"event":"test","delivery_id":"5f0c"}';
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const hmac = (data: string) => createHmac("sha256", SECRET).update(data, "utf8").digest("hex");

describe("signatureHeaders", () => {
  it("sends both schemes: the legacy body-only HMAC and the timestamped one", () => {
    const headers = signatureHeaders(SECRET, BODY, NOW);
    const ts = String(NOW / 1000);
    expect(headers).toEqual({
      "X-Signature": hmac(BODY),
      "X-GTF-Timestamp": ts,
      "X-GTF-Signature": `v2=${hmac(`${ts}.${BODY}`)}`,
    });
  });
});

describe("verifyTimestamped", () => {
  const sign = (nowMs = NOW) => signatureHeaders(SECRET, BODY, nowMs);
  const check = (headers: Record<string, string>, body = BODY, secret: string | null = SECRET, nowMs = NOW) =>
    verifyTimestamped(body, headers["X-GTF-Signature"], headers["X-GTF-Timestamp"], secret ?? undefined, nowMs);

  it("accepts a fresh delivery, at either edge of the window", () => {
    expect(check(sign())).toEqual({ ok: true, timestamp: NOW / 1000 });
    expect(check(sign(NOW - SIGNATURE_TOLERANCE_SECONDS * 1000)).ok).toBe(true);
    expect(check(sign(NOW + SIGNATURE_TOLERANCE_SECONDS * 1000)).ok).toBe(true);
  });

  it("refuses a genuine delivery outside the window", () => {
    expect(check(sign(NOW - (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000))).toEqual({ ok: false, reason: "stale" });
    expect(check(sign(NOW + (SIGNATURE_TOLERANCE_SECONDS + 1) * 1000))).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a timestamp that is not the one signed", () => {
    const headers = sign(NOW - 3600_000);
    expect(check({ ...headers, "X-GTF-Timestamp": String(NOW / 1000) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses another body, another secret, no secret and missing headers", () => {
    expect(check(sign(), `${BODY} `).ok).toBe(false);
    expect(check(sign(), BODY, "other").ok).toBe(false);
    expect(check(sign(), BODY, null)).toEqual({ ok: false, reason: "no_secret" });
    expect(check({})).toEqual({ ok: false, reason: "missing" });
    expect(check({ "X-GTF-Signature": sign()["X-GTF-Signature"] })).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses the legacy signature in the new header, and garbage", () => {
    const ts = String(NOW / 1000);
    expect(check({ "X-GTF-Timestamp": ts, "X-GTF-Signature": `v2=${hmac(BODY)}` }).ok).toBe(false);
    expect(check({ "X-GTF-Timestamp": ts, "X-GTF-Signature": hmac(`${ts}.${BODY}`) }).ok).toBe(false);
    expect(check({ "X-GTF-Timestamp": ts, "X-GTF-Signature": "v2=zz" }).ok).toBe(false);
    expect(check({ "X-GTF-Timestamp": "1e9", "X-GTF-Signature": "v2=00" })).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("accepts the header when any v2 entry matches, so a later scheme can sit beside it", () => {
    const ts = String(NOW / 1000);
    const header = `v3=abcd, v2=${signTimestamped(SECRET, ts, BODY)}`;
    expect(check({ "X-GTF-Timestamp": ts, "X-GTF-Signature": header }).ok).toBe(true);
  });
});

describe("WebhookAdapter on the wire", () => {
  it("signs the exact bytes it sends, both ways, with a delivery_id inside them", async () => {
    await new WebhookAdapter({ url: "https://receiver.test/hook", secret: SECRET }).testConnection();

    const [, init] = sent.calls[0];
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(body)).toMatchObject({ event: "test", delivery_id: expect.any(String) });
    expect(headers["X-Signature"]).toBe(hmac(body));
    expect(verifyTimestamped(body, headers["X-GTF-Signature"], headers["X-GTF-Timestamp"], SECRET).ok).toBe(true);
  });
});
