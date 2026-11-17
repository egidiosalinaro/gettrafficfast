import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Script from "next/script";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieConsentView, CookieSettingsButton } from "@/components/cookie-consent";
import { LandingFooter } from "@/components/landing/footer";
import {
  analyticsAllowed,
  analyticsCookieNames,
  analyticsWebsiteId,
  consentExpiry,
  consentReducer,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  expireCookieAssignments,
  INITIAL_CONSENT_STATE,
  OPEN_COOKIE_SETTINGS_EVENT,
  parseConsent,
  readConsent,
  serializeConsent,
  writeConsent,
  type ConsentState,
  type ConsentStorage,
} from "@/lib/cookie-consent";

/**
 * The cookie banner (components/cookie-consent.tsx, lib/cookie-consent.ts).
 * Pinned: the analytics script is absent until an explicit Accept, absent
 * after Reject, the banner reopens from "Cookie settings", the choice is
 * kept six months and storage failures never throw, and a deployment with
 * no analytics id has no banner and no link. Fictional website id only.
 */

const WEBSITE_ID = "test-site-id";
const DOMAIN = "example.test";
const NOW = new Date("2026-11-17T10:00:00Z");

function memoryStorage(): ConsentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwing: ConsentStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

/** Every element in the tree the view returns (function components unexpanded). */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

function view(state: ConsentState) {
  return CookieConsentView({ state, websiteId: WEBSITE_ID, domain: DOMAIN, onAccept: () => {}, onReject: () => {} });
}

function scripts(state: ConsentState): ReactElement[] {
  return elements(view(state)).filter((element) => element.type === Script);
}

function bannerMarkup(state: ConsentState): string {
  // The view without its script: next/script needs Next's runtime to render.
  const tree = view(state);
  const banner = elements(tree).find((element) => element.type === "section");
  return renderToStaticMarkup(banner!);
}

function run(...actions: Parameters<typeof consentReducer>[1][]): ConsentState {
  return actions.reduce(consentReducer, INITIAL_CONSENT_STATE);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("before any choice", () => {
  it("the server render has no script and the banner hidden", () => {
    expect(scripts(INITIAL_CONSENT_STATE)).toEqual([]);
    const html = bannerMarkup(INITIAL_CONSENT_STATE);
    expect(html).toContain('id="cookie-consent"');
    expect(html).toContain("hidden");
  });

  it("a first visit shows the banner and still no script", () => {
    const state = run({ type: "loaded", choice: null });
    expect(state.open).toBe(true);
    expect(analyticsAllowed(state)).toBe(false);
    expect(scripts(state)).toEqual([]);
    const html = bannerMarkup(state);
    expect(html).not.toMatch(/hidden=""/);
    expect(html).toContain('href="/privacy-policy#cookies"');
    expect(html).toContain("always on");
  });

  it("offers Accept and Reject alike, nothing pre-selected", () => {
    const buttons = elements(view(run({ type: "loaded", choice: null }))).filter((element) => element.type === "button");
    expect(buttons.map((button) => (button.props as { children: string }).children)).toEqual(["Reject", "Accept"]);
    const [reject, accept] = buttons.map((button) => (button.props as { className: string }).className);
    expect(reject).toBe(accept);
    expect(reject).toContain("min-h-11");
    expect(bannerMarkup(run({ type: "loaded", choice: null }))).not.toMatch(/checkbox|checked/);
  });
});

describe("after a choice", () => {
  it("Accept loads the DataFast script with the property", () => {
    const state = run({ type: "loaded", choice: null }, { type: "accept" });
    expect(state.open).toBe(false);
    const [script, ...rest] = scripts(state);
    expect(rest).toEqual([]);
    expect(script.props).toMatchObject({
      src: "https://datafa.st/js/script.js",
      "data-website-id": WEBSITE_ID,
      "data-domain": DOMAIN,
      strategy: "afterInteractive",
    });
  });

  it("Reject never loads it", () => {
    const state = run({ type: "loaded", choice: null }, { type: "reject" });
    expect(state.open).toBe(false);
    expect(scripts(state)).toEqual([]);
    expect(scripts(consentReducer(state, { type: "reopen" }))).toEqual([]);
  });

  it("a stored choice is honoured without asking", () => {
    expect(run({ type: "loaded", choice: "granted" })).toMatchObject({ open: false, choice: "granted" });
    expect(scripts(run({ type: "loaded", choice: "granted" }))).toHaveLength(1);
    expect(run({ type: "loaded", choice: "denied" })).toMatchObject({ open: false, choice: "denied" });
    expect(scripts(run({ type: "loaded", choice: "denied" }))).toEqual([]);
  });

  it("withdrawing an accept turns the script off", () => {
    const state = run({ type: "loaded", choice: "granted" }, { type: "reopen" }, { type: "reject" });
    expect(scripts(state)).toEqual([]);
  });
});

describe("Cookie settings", () => {
  it("the footer link reopens the banner", () => {
    vi.stubEnv("NEXT_PUBLIC_DATAFAST_WEBSITE_ID", WEBSITE_ID);
    expect(renderToStaticMarkup(<LandingFooter />)).toContain("Cookie settings");

    const target = new EventTarget();
    vi.stubGlobal("window", target);
    let state = run({ type: "loaded", choice: "denied" });
    target.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, () => {
      state = consentReducer(state, { type: "reopen" });
    });
    const button = CookieSettingsButton({}) as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(state.open).toBe(true);
    expect(state.choice).toBe("denied");
    expect(scripts(state)).toEqual([]);
  });
});

describe("without NEXT_PUBLIC_DATAFAST_WEBSITE_ID", () => {
  it("there is no banner, no link and no script", () => {
    vi.stubEnv("NEXT_PUBLIC_DATAFAST_WEBSITE_ID", "");
    expect(analyticsWebsiteId()).toBeNull();
    expect(renderToStaticMarkup(<LandingFooter />)).not.toContain("Cookie settings");
    vi.stubEnv("NEXT_PUBLIC_DATAFAST_WEBSITE_ID", " ");
    expect(analyticsWebsiteId()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_DATAFAST_WEBSITE_ID", WEBSITE_ID);
    expect(analyticsWebsiteId()).toBe(WEBSITE_ID);
  });
});

describe("storing the choice", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(readConsent(storage, NOW)).toBeNull();
    expect(writeConsent(storage, "granted", NOW)).toBe(true);
    expect(JSON.parse(storage.data.get(CONSENT_STORAGE_KEY)!)).toEqual({
      v: CONSENT_VERSION,
      choice: "granted",
      at: NOW.toISOString(),
    });
    expect(readConsent(storage, NOW)).toBe("granted");
    writeConsent(storage, "denied", NOW);
    expect(readConsent(storage, NOW)).toBe("denied");
  });

  it("holds six months, then asks again", () => {
    expect(consentExpiry(NOW).toISOString()).toBe("2027-05-17T10:00:00.000Z");
    const raw = serializeConsent("denied", NOW);
    expect(parseConsent(raw, new Date("2027-05-17T09:59:59Z"))).toBe("denied");
    expect(parseConsent(raw, new Date("2027-05-17T10:00:00Z"))).toBeNull();
  });

  it("asks again when the version changes or the value is unreadable", () => {
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION + 1, choice: "granted", at: NOW.toISOString() }), NOW)).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, choice: "yes", at: NOW.toISOString() }), NOW)).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, choice: "granted", at: "nonsense" }), NOW)).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, choice: "granted", at: "2030-01-01T00:00:00Z" }), NOW)).toBeNull();
    expect(parseConsent("{not json", NOW)).toBeNull();
    expect(parseConsent("null", NOW)).toBeNull();
    expect(parseConsent(null, NOW)).toBeNull();
  });

  it("never throws when storage is blocked: no choice, banner asks", () => {
    expect(readConsent(throwing, NOW)).toBeNull();
    expect(writeConsent(throwing, "granted", NOW)).toBe(false);
    expect(readConsent(null, NOW)).toBeNull();
    expect(writeConsent(undefined, "granted", NOW)).toBe(false);
  });
});

describe("deleting the analytics cookies on withdrawal", () => {
  it("finds only DataFast's cookies", () => {
    expect(analyticsCookieNames("sb-access=1; datafast_visitor_id=abc; theme=dark; datafast_session_id=def")).toEqual([
      "datafast_visitor_id",
      "datafast_session_id",
    ]);
    expect(analyticsCookieNames("")).toEqual([]);
  });

  it("expires them on the host and its parent domain", () => {
    expect(expireCookieAssignments("datafast_visitor_id", "www.example.test")).toEqual([
      "datafast_visitor_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/",
      "datafast_visitor_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=www.example.test",
      "datafast_visitor_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=example.test",
    ]);
  });
});
