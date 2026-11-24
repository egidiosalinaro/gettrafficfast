import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const nav = vi.hoisted(() => ({ pathname: "/settings" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { settingsBack, settingsGroups, settingsItems } from "@/components/dashboard/settings-nav";
import { SettingsBackLink, SettingsSubmenu } from "@/components/dashboard/settings-submenu";
import { SettingsOverview } from "@/components/settings/settings-overview";
import { XAccountCard } from "@/components/settings/x-account";
import { SETTINGS_PATH as SEARCH_CONSOLE_RETURN } from "@/app/api/integrations/search-console/shared";
import { LEGACY_REDIRECTS } from "@/lib/legacy-redirects";
import { ONBOARDING_STEPS } from "@/lib/onboarding";

/**
 * Settings, regrouped (phase 2 of the UX simplification, 2026-11-14): three
 * groups instead of eight tabs, one list read by the phone's page, the
 * desktop column and the back links. Pinned: the groups and their order, the
 * paths external services return to, the moved page's redirect, the back
 * link's rule, 44px rows, and Find posts on X living in Connections.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const pageFile = (href: string) => `app/(app)${href}/page.tsx`;

describe("the groups", () => {
  it("are This site, Plan and You, in the approved order", () => {
    expect(settingsGroups.map((group) => [group.title, group.items.map((item) => item.title)])).toEqual([
      ["This site", ["Business", "Voice and facts", "Connections", "Claude and API", "Autopilot"]],
      ["Plan", ["Billing"]],
      ["You", ["Account", "Docs and help"]],
    ]);
  });

  it("keeps the paths that Google, Stripe and the emails return to", () => {
    const hrefs = settingsItems.map((item) => item.href);
    expect(hrefs).toEqual([
      "/settings/business",
      "/settings/voice",
      "/settings/integrations",
      "/settings/api-keys",
      "/settings/automation",
      "/settings/billing",
      "/settings/account",
      "/docs",
    ]);
    // Google's consent screen comes back under Connections.
    expect(SEARCH_CONSOLE_RETURN.startsWith("/settings/integrations/")).toBe(true);
    // Stripe's billing portal comes back to Billing.
    expect(source("app/api/create-billing-portal-session/route.ts")).toContain("/settings/billing");
    expect(hrefs).not.toContain("/settings/generation");
    expect(hrefs).not.toContain("/settings/team-members");
  });

  it("titles every page as the list names it", () => {
    for (const item of settingsItems.filter((entry) => !entry.external)) {
      expect(existsSync(path.join(root, pageFile(item.href))), item.href).toBe(true);
      expect(source(pageFile(item.href)), item.href).toContain(item.title);
    }
    expect(source("app/(app)/settings/voice/page.tsx")).toContain(">Voice and facts</h1>");
    expect(source("app/(app)/settings/integrations/page.tsx")).toContain(">Connections</h1>");
    expect(source("app/(app)/settings/api-keys/page.tsx")).toContain(">Claude and API</h1>");
    expect(source("app/(app)/settings/automation/page.tsx")).toContain(">Autopilot</h1>");
  });

  it("opens the docs outside the app, where a home-screen app keeps its way back", () => {
    const docs = settingsItems.find((item) => item.href === "/docs");
    expect(docs?.external).toBe(true);
  });
});

describe("Images and video, folded into Autopilot", () => {
  it("redirects the old path to the section, with its query string carried by Next.js", () => {
    expect(LEGACY_REDIRECTS).toContainEqual({
      source: "/settings/generation",
      destination: "/settings/automation#images",
      permanent: false,
    });
    expect(existsSync(path.join(root, "app/(app)/settings/generation/page.tsx"))).toBe(false);
    const autopilot = source("app/(app)/settings/automation/page.tsx");
    expect(autopilot).toContain('id="images"');
    expect(autopilot).toContain("<MediaSettingsForm />");
    expect(source("next.config.ts")).toContain("LEGACY_REDIRECTS");
  });

  it("has no checklist step for images: they are on by default", () => {
    expect(ONBOARDING_STEPS.map((step) => step.href)).not.toContain("/settings/automation#images");
  });
});

describe("the way back", () => {
  it("goes to Settings from a page of the list, on a phone only", () => {
    expect(settingsBack("/settings")).toBeNull();
    expect(settingsBack("/dashboard")).toBeNull();
    expect(settingsBack("/settings/voice")).toEqual({ href: "/settings", label: "Settings", always: false });
    expect(settingsBack("/settings/billing")).toEqual({ href: "/settings", label: "Settings", always: false });
  });

  it("goes to the parent from a page under it, on every screen", () => {
    for (const page of ["/settings/integrations/wordpress", "/settings/integrations/webhook", SEARCH_CONSOLE_RETURN]) {
      expect(settingsBack(page)).toEqual({ href: "/settings/integrations", label: "Connections", always: true });
    }
  });

  it("renders as a 44px link, hidden from md up only where the column replaces it", () => {
    nav.pathname = "/settings/voice";
    const phone = renderToStaticMarkup(<SettingsBackLink />);
    expect(phone).toContain('href="/settings"');
    expect(phone).toContain("min-h-[44px]");
    expect(phone).toContain("md:hidden");

    nav.pathname = "/settings/integrations/wordpress";
    const nested = renderToStaticMarkup(<SettingsBackLink />);
    expect(nested).toContain('href="/settings/integrations"');
    expect(nested).toContain("Connections");
    expect(nested).not.toContain("md:hidden");

    nav.pathname = "/settings";
    expect(renderToStaticMarkup(<SettingsBackLink />)).toBe("");
  });

  it("is in the layout, which has no sideways tabs any more", () => {
    const layout = source("app/(app)/settings/layout.tsx");
    expect(layout).toContain("<SettingsBackLink />");
    expect(layout).not.toContain("SettingsTabs");
    // The sub-pages no longer draw their own.
    for (const page of ["wordpress", "webhook", "search-console"]) {
      expect(source(`app/(app)/settings/integrations/${page}/page.tsx`)).not.toContain('href="/settings/integrations"');
    }
  });
});

describe("the desktop column", () => {
  it("is hidden below md, lists every group and marks the current page", () => {
    nav.pathname = "/settings/integrations/wordpress";
    const html = renderToStaticMarkup(<SettingsSubmenu businessName="Acme" />);
    expect(html).toMatch(/<aside class="[^"]*\bhidden\b[^"]*\bmd:flex\b/);
    for (const group of settingsGroups) expect(html).toContain(group.title);
    for (const item of settingsItems) expect(html).toContain(`href="${item.href}"`);
    expect(html).toContain("Acme");
    expect(html).toMatch(/aria-current="page"[^>]*href="\/settings\/integrations"|href="\/settings\/integrations"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="\/docs"[^>]*target="_blank"|target="_blank"[^>]*href="\/docs"/);
  });
});

describe("the phone's list", () => {
  const plan = { name: "Business plan", detail: "Free trial · trial ends Nov 20", needsAttention: false };

  it("shows every row with what is inside it, as a 60px target", () => {
    const html = renderToStaticMarkup(<SettingsOverview siteName="Acme" plan={plan} />);
    expect(html).toContain(">Settings</h1>");
    for (const item of settingsItems.filter((entry) => entry.href !== "/settings/billing")) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(item.description);
    }
    expect((html.match(/min-h-\[60px\]/g) ?? []).length).toBe(settingsItems.length);
    expect(html).toContain("Acme");
  });

  it("shows the plan from the subscription row, with a way to manage it", () => {
    const html = renderToStaticMarkup(<SettingsOverview siteName={null} plan={plan} />);
    expect(html).toContain("Business plan");
    expect(html).toContain("Free trial · trial ends Nov 20");
    expect(html).toContain('href="/settings/billing"');
    expect(html).toContain("Manage");

    const late = renderToStaticMarkup(
      <SettingsOverview siteName={null} plan={{ ...plan, detail: "Payment past due", needsAttention: true }} />
    );
    expect(late).toContain("text-red-700 dark:text-red-400");

    const none = renderToStaticMarkup(<SettingsOverview siteName={null} plan={null} />);
    expect(none).toContain("No subscription is recorded for this account.");
  });

  it("no longer redirects to Business: the list is the page", () => {
    expect(source("app/(app)/settings/page.tsx")).not.toContain('redirect("/settings/business")');
  });
});

describe("X, in Connections (no per-site switch since 2026-11-24)", () => {
  it("has no switch: on for every site when the platform reads X, a plain sentence when it does not", () => {
    const on = renderToStaticMarkup(<XAccountCard saved={null} inferred={null} available hasBusiness />);
    expect(on).not.toContain('role="switch"');
    expect(on).not.toContain("Find posts on X");
    expect(on).toContain("On for every site");
    expect(on).toContain("Your X account");

    const off = renderToStaticMarkup(<XAccountCard saved={null} inferred={null} available={false} hasBusiness />);
    expect(off).toContain("Not available yet");
  });

  it("shows the saved account, else the one the saved links name", () => {
    expect(renderToStaticMarkup(<XAccountCard saved="postwren" inferred="other" available hasBusiness />)).toContain('value="postwren"');
    const inferred = renderToStaticMarkup(<XAccountCard saved={null} inferred="samrivdev" available hasBusiness />);
    expect(inferred).toContain("From your saved reply links: @samrivdev");
    expect(inferred).toContain('value=""');
  });

  it("saves only the account, through the partial PATCH", () => {
    const field = source("components/placements/x-handle-field.tsx");
    expect(field).toContain('method: "PATCH"');
    expect(field).toContain("JSON.stringify({ xHandle: handle })");
    expect(source("app/(app)/settings/integrations/page.tsx")).toContain("<XAccountCard");
    expect(source("app/(app)/settings/integrations/page.tsx")).not.toContain("findPostsOnX");
  });
});

describe("Account", () => {
  it("has sign out, now that the phone has no account menu", () => {
    expect(source("app/(app)/settings/account/page.tsx")).toContain("<SignOutButton />");
    expect(source("components/settings/sign-out-button.tsx")).toContain("auth.signOut()");
  });
});

describe("the owner's Costs row", () => {
  const plan = { name: "Business plan", detail: "Active", needsAttention: false };

  it("is not on a customer's list or column, nor among the groups everyone sees", () => {
    expect(settingsItems.map((item) => item.href)).not.toContain("/settings/costs");
    expect(renderToStaticMarkup(<SettingsOverview siteName="Acme" plan={plan} />)).not.toContain("/settings/costs");
    nav.pathname = "/settings";
    expect(renderToStaticMarkup(<SettingsSubmenu businessName="Acme" />)).not.toContain("/settings/costs");
    expect(renderToStaticMarkup(<SettingsSubmenu businessName="Acme" isOwner={false} />)).not.toContain("Platform");
  });

  it("is listed last, under Platform, for an owner, as a 60px row", () => {
    const html = renderToStaticMarkup(<SettingsOverview siteName="Acme" plan={plan} isOwner />);
    expect(html).toContain('href="/settings/costs"');
    expect(html).toContain("Platform");
    expect(html.indexOf("/settings/costs")).toBeGreaterThan(html.indexOf('href="/docs"'));
    expect((html.match(/min-h-\[60px\]/g) ?? []).length).toBe(settingsItems.length + 1);
    expect(renderToStaticMarkup(<SettingsSubmenu businessName="Acme" isOwner />)).toContain('href="/settings/costs"');
  });

  it("is decided on the server from PLATFORM_OWNER_USER_IDS and the selected site, by the layout and the list", () => {
    expect(source("app/(app)/settings/layout.tsx")).toContain("isOwner={isPlatformOwnerHere(userId, selected?.id)}");
    expect(source("app/(app)/settings/page.tsx")).toContain("isOwner={isPlatformOwnerHere(userId, selected?.id)}");
  });
});
