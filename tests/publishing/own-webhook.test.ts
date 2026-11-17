import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOwnSite, isOwnWebhookReceiver, ownWebhookUrl } from "@/lib/site";
import { encryptSecret } from "@/lib/integrations/crypto";
import { resolveWebhookSecret } from "@/lib/publishing/webhook-secret";
import { isOwnBlogOwner, mayUseWebhookUrl } from "@/lib/publishing/own-blog";

describe("own webhook receiver", () => {
  it("is this site's /api/gettrafficfast, slash or not", () => {
    expect(ownWebhookUrl()).toBe("https://gettrafficfa.st/api/gettrafficfast");
    expect(isOwnWebhookReceiver("https://gettrafficfa.st/api/gettrafficfast")).toBe(
      true
    );
    expect(isOwnWebhookReceiver("https://gettrafficfa.st/api/gettrafficfast/")).toBe(
      true
    );
  });

  it("is not a customer's receiver, even on a similar path", () => {
    expect(
      isOwnWebhookReceiver("https://www.postwren.me/api/integrations/gettrafficfast")
    ).toBe(false);
    expect(isOwnWebhookReceiver("https://gettrafficfa.st/api/other")).toBe(false);
  });

  it("recognises the product's own business URL", () => {
    expect(isOwnSite("https://gettrafficfa.st/")).toBe(true);
    expect(isOwnSite("https://gettrafficfa.st")).toBe(true);
    expect(isOwnSite("https://postwren.me")).toBe(false);
    expect(isOwnSite(null)).toBe(false);
  });
});

const OWN = "https://gettrafficfa.st/api/gettrafficfast";
const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

/** Sets env vars for one test and puts the previous values back after it. */
function useEnv(values: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [key, value] of Object.entries(values)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("own blog owner", () => {
  describe("with OWN_BLOG_OWNER_USER_IDS set", () => {
    useEnv({ OWN_BLOG_OWNER_USER_IDS: ` ${OWNER.toUpperCase()} , 33333333-3333-3333-3333-333333333333` });

    it("recognises an operator, whatever the spacing and case", () => {
      expect(isOwnBlogOwner(OWNER)).toBe(true);
      expect(isOwnBlogOwner("33333333-3333-3333-3333-333333333333")).toBe(true);
    });

    it("refuses everyone else, and no user at all", () => {
      expect(isOwnBlogOwner(STRANGER)).toBe(false);
      expect(isOwnBlogOwner(null)).toBe(false);
      expect(isOwnBlogOwner("")).toBe(false);
    });

    it("lets only the operator point an integration at the own receiver", () => {
      expect(mayUseWebhookUrl(OWN, OWNER)).toBe(true);
      expect(mayUseWebhookUrl(`${OWN}/`, STRANGER)).toBe(false);
      expect(mayUseWebhookUrl("https://customer.example/hook", STRANGER)).toBe(true);
    });
  });

  describe("with OWN_BLOG_OWNER_USER_IDS unset", () => {
    useEnv({ OWN_BLOG_OWNER_USER_IDS: undefined });

    it("fails closed: nobody owns the blog", () => {
      expect(isOwnBlogOwner(OWNER)).toBe(false);
      expect(mayUseWebhookUrl(OWN, OWNER)).toBe(false);
    });
  });
});

describe("resolveWebhookSecret", () => {
  useEnv({
    BLOG_WEBHOOK_SECRET: "from-env",
    OWN_BLOG_OWNER_USER_IDS: OWNER,
    INTEGRATIONS_ENCRYPTION_KEY: "ab".repeat(32),
  });

  it("signs the own receiver with BLOG_WEBHOOK_SECRET for the operator, not a stored copy", () => {
    expect(resolveWebhookSecret({ url: OWN, secret_encrypted: "must-not-be-used" }, OWNER)).toBe(
      "from-env"
    );
  });

  it("refuses to sign the own receiver for anyone else", () => {
    expect(() => resolveWebhookSecret({ url: OWN }, STRANGER)).toThrow(/reserved/);
    expect(() =>
      resolveWebhookSecret({ url: OWN, secret_encrypted: encryptSecret("guess") }, STRANGER)
    ).toThrow(/reserved/);
  });

  it("ignores a secret_from_env flag in the row: the URL and the owner decide", () => {
    // A user can write their own integration row. A flag in it must not hand
    // them the blog's secret for a destination of their choosing.
    const config = { url: "https://attacker.example/hook", secret_from_env: true } as {
      url: string;
    };
    expect(() => resolveWebhookSecret(config, STRANGER)).toThrow(/misconfigured/);
    expect(() => resolveWebhookSecret(config, OWNER)).toThrow(/misconfigured/);
  });

  it("signs a customer destination with the pasted secret, not BLOG_WEBHOOK_SECRET", () => {
    const secret_encrypted = encryptSecret("customer-secret");
    expect(
      resolveWebhookSecret(
        { url: "https://www.postwren.me/api/integrations/gettrafficfast", secret_encrypted },
        OWNER
      )
    ).toBe("customer-secret");
  });

  it("still resolves the operator's legacy row ({url, secret_from_env: true})", () => {
    // The row the connect route wrote before this change.
    expect(resolveWebhookSecret({ url: OWN, secret_from_env: true } as { url: string }, OWNER)).toBe(
      "from-env"
    );
  });

  describe("without BLOG_WEBHOOK_SECRET", () => {
    useEnv({ BLOG_WEBHOOK_SECRET: undefined });

    it("refuses to sign the own receiver", () => {
      expect(() => resolveWebhookSecret({ url: OWN }, OWNER)).toThrow(/BLOG_WEBHOOK_SECRET/);
    });
  });
});
