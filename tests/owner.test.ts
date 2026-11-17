import { describe, expect, it } from "vitest";
import { isPlatformOwner, platformOwnerIds } from "@/lib/owner";

/**
 * Who runs the platform (lib/owner.ts). What is pinned: only an id listed in
 * PLATFORM_OWNER_USER_IDS is an owner; unset, empty or blank means nobody is
 * (fail closed); spaces around the commas do not matter; a prefix or a part
 * of an id is not an id.
 */

const OWNER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";

describe("isPlatformOwner", () => {
  it("is true only for a listed id", () => {
    const env = { PLATFORM_OWNER_USER_IDS: OWNER };
    expect(isPlatformOwner(OWNER, env)).toBe(true);
    expect(isPlatformOwner(CUSTOMER, env)).toBe(false);
  });

  it("fails closed: unset, empty or blank lists nobody", () => {
    for (const env of [{}, { PLATFORM_OWNER_USER_IDS: "" }, { PLATFORM_OWNER_USER_IDS: "  " }, { PLATFORM_OWNER_USER_IDS: " , ," }]) {
      expect(platformOwnerIds(env)).toEqual([]);
      expect(isPlatformOwner(OWNER, env)).toBe(false);
      expect(isPlatformOwner("", env)).toBe(false);
    }
  });

  it("reads a comma-separated list, spaces around the commas included", () => {
    const env = { PLATFORM_OWNER_USER_IDS: ` ${CUSTOMER} ,${OWNER} ` };
    expect(platformOwnerIds(env)).toEqual([CUSTOMER, OWNER]);
    expect(isPlatformOwner(OWNER, env)).toBe(true);
    expect(isPlatformOwner(CUSTOMER, env)).toBe(true);
  });

  it("never matches a missing, empty or partial id", () => {
    const env = { PLATFORM_OWNER_USER_IDS: OWNER };
    expect(isPlatformOwner(null, env)).toBe(false);
    expect(isPlatformOwner(undefined, env)).toBe(false);
    expect(isPlatformOwner("", env)).toBe(false);
    expect(isPlatformOwner(OWNER.slice(0, 8), env)).toBe(false);
    expect(isPlatformOwner(`${OWNER},${CUSTOMER}`, env)).toBe(false);
  });

  it("reads process.env by default", () => {
    const before = process.env.PLATFORM_OWNER_USER_IDS;
    try {
      delete process.env.PLATFORM_OWNER_USER_IDS;
      expect(isPlatformOwner(OWNER)).toBe(false);
      process.env.PLATFORM_OWNER_USER_IDS = OWNER;
      expect(isPlatformOwner(OWNER)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PLATFORM_OWNER_USER_IDS;
      else process.env.PLATFORM_OWNER_USER_IDS = before;
    }
  });
});
