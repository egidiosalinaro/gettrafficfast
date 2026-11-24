import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlatformOwner,
  isPlatformOwnerHere,
  isPlatformOwnerSite,
  platformOwnerBusinessIds,
  platformOwnerIds,
} from "@/lib/owner";

/**
 * Who runs the platform (lib/owner.ts). What is pinned: only an id listed in
 * PLATFORM_OWNER_USER_IDS is an owner; unset, empty or blank means nobody is
 * (fail closed); spaces around the commas do not matter; a prefix or a part
 * of an id is not an id.
 *
 * The owner's sites: with PLATFORM_OWNER_BUSINESS_IDS set, an owner is an
 * owner only on a listed site (another site, or no site, gets the customer's
 * answer); unset, empty or blank, on every site, as before; a customer is
 * never one, whatever the site. Every owner-only feature asks
 * `isPlatformOwnerHere`, never `isPlatformOwner` alone.
 */

const OWNER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PLATFORM_SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

describe("isPlatformOwnerHere: the owner's sites", () => {
  it("with PLATFORM_OWNER_BUSINESS_IDS set, is true only for an owner on a listed site", () => {
    const env = { PLATFORM_OWNER_USER_IDS: OWNER, PLATFORM_OWNER_BUSINESS_IDS: PLATFORM_SITE };
    expect(isPlatformOwnerHere(OWNER, PLATFORM_SITE, env)).toBe(true);
    expect(isPlatformOwnerHere(OWNER, OTHER_SITE, env)).toBe(false);
    expect(isPlatformOwnerHere(OWNER, null, env)).toBe(false);
    expect(isPlatformOwnerHere(OWNER, undefined, env)).toBe(false);
    expect(isPlatformOwnerHere(OWNER, "", env)).toBe(false);
    expect(isPlatformOwnerHere(OWNER, PLATFORM_SITE.slice(0, 8), env)).toBe(false);
  });

  it("never makes a customer an owner, on any site", () => {
    const env = { PLATFORM_OWNER_USER_IDS: OWNER, PLATFORM_OWNER_BUSINESS_IDS: PLATFORM_SITE };
    expect(isPlatformOwnerHere(CUSTOMER, PLATFORM_SITE, env)).toBe(false);
    expect(isPlatformOwnerHere(CUSTOMER, PLATFORM_SITE, { PLATFORM_OWNER_BUSINESS_IDS: PLATFORM_SITE })).toBe(false);
    expect(isPlatformOwnerHere(OWNER, PLATFORM_SITE, { PLATFORM_OWNER_BUSINESS_IDS: PLATFORM_SITE })).toBe(false);
  });

  it("unset, empty or blank: no site condition, as before the variable existed", () => {
    for (const sites of [undefined, "", "  ", " , ,"]) {
      const env = { PLATFORM_OWNER_USER_IDS: OWNER, PLATFORM_OWNER_BUSINESS_IDS: sites };
      expect(platformOwnerBusinessIds(env)).toBeNull();
      expect(isPlatformOwnerSite(OTHER_SITE, env)).toBe(true);
      for (const site of [PLATFORM_SITE, OTHER_SITE, null]) {
        expect(isPlatformOwnerHere(OWNER, site, env)).toBe(true);
        expect(isPlatformOwnerHere(CUSTOMER, site, env)).toBe(false);
      }
    }
  });

  it("reads a comma-separated list of sites, case and spaces aside", () => {
    const env = { PLATFORM_OWNER_USER_IDS: OWNER, PLATFORM_OWNER_BUSINESS_IDS: ` ${OTHER_SITE.toUpperCase()} , ${PLATFORM_SITE} ` };
    expect(platformOwnerBusinessIds(env)).toEqual([OTHER_SITE, PLATFORM_SITE]);
    expect(isPlatformOwnerHere(OWNER, OTHER_SITE, env)).toBe(true);
    expect(isPlatformOwnerHere(OWNER, PLATFORM_SITE.toUpperCase(), env)).toBe(true);
  });
});

describe("every owner-only feature goes through isPlatformOwnerHere", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("asks isPlatformOwner alone nowhere but lib/owner.ts and the off-site refusal", () => {
    const root = process.cwd();
    const callers = ["app", "lib", "components"]
      .flatMap((dir) => files(join(root, dir)))
      .map((path) => ({ path: path.slice(root.length + 1), calls: (readFileSync(path, "utf8").match(/\bisPlatformOwner\(/g) ?? []).length }))
      .filter((file) => file.calls > 0);
    expect(callers.map((file) => file.path).sort()).toEqual(["lib/owner.ts", "lib/tools/owner.ts"]);
    // lib/tools/owner.ts: only `offSiteOwnerTool`, which grants nothing (it words a refusal).
    expect(callers.find((file) => file.path === "lib/tools/owner.ts")?.calls).toBe(1);
  });
});
