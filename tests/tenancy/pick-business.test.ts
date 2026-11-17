import { describe, expect, it } from "vitest";
import { pickBusiness } from "@/lib/tenancy";

/**
 * The selection rule is the whole access boundary of multi-business: a
 * requested id is honoured only if it is one of the user's own. These tests
 * exist because the tempting shortcut — trusting the cookie and filtering
 * queries by it — reads identically in the happy path and hands one account's
 * articles to another in the unhappy one.
 */

const postwren = { id: "b-postwren", name: "Postwren" };
const gtf = { id: "b-gtf", name: "GetTrafficFast" };

describe("pickBusiness", () => {
  it("returns null when the account has no business", () => {
    expect(pickBusiness([], "b-gtf")).toBeNull();
    expect(pickBusiness([], null)).toBeNull();
  });

  it("honours a requested business the user owns", () => {
    expect(pickBusiness([postwren, gtf], "b-gtf")).toBe(gtf);
  });

  it("ignores an id the user does not own and falls back to the oldest", () => {
    expect(pickBusiness([postwren, gtf], "b-somebody-else")).toBe(postwren);
  });

  it("falls back to the oldest when nothing is requested", () => {
    expect(pickBusiness([postwren, gtf], null)).toBe(postwren);
    expect(pickBusiness([postwren, gtf])).toBe(postwren);
  });

  it("treats an empty cookie value as no request", () => {
    expect(pickBusiness([postwren, gtf], "")).toBe(postwren);
  });
});
