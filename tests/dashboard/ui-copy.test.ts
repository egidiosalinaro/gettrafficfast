import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluralize } from "@/lib/utils";

/**
 * What a customer reads inside the app. The 2026-11-09 UI audit found
 * operator copy on customer screens (env var names, "every probe is a paid
 * call", an estimated cost per run), controls that did nothing, an invented
 * testimonial, and native alert/confirm dialogs. Comments may still explain
 * cost to the next engineer: they are stripped before checking.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

/** The file without block, JSX and line comments. */
function shown(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const CUSTOMER_SCREENS = [
  "components/growth/ai-answers.tsx",
  "app/(app)/growth/ai/settings/page.tsx",
  "app/(app)/growth/ai/queries/[id]/page.tsx",
  "app/(app)/content/topics/page.tsx",
  "components/content/content-parts.tsx",
  "components/content/content-screen.tsx",
  "components/keywords/add-keywords-modal.tsx",
  "app/(app)/settings/account/page.tsx",
  "app/(app)/settings/automation/page.tsx",
  "app/(app)/settings/billing/page.tsx",
  "components/billing/plan-usage.tsx",
  "app/(app)/settings/voice/page.tsx",
  "app/(app)/settings/business/page.tsx",
  "app/(app)/settings/integrations/page.tsx",
  "app/(app)/settings/api-keys/page.tsx",
  "components/settings/settings-overview.tsx",
  "components/dashboard/settings-nav.ts",
  "components/settings/x-account.tsx",
  "components/placements/x-handle-field.tsx",
  "components/settings/sign-out-button.tsx",
  "components/settings/media-settings-form.tsx",
  "components/settings/voice-settings-form.tsx",
  "app/docs/page.tsx",
  "components/docs/docs-content.tsx",
  "components/docs/tool-groups.ts",
  "components/onboarding/getting-started.tsx",
  "components/dashboard/sidebar.tsx",
  "components/dashboard/mobile-nav.tsx",
  "components/dashboard/nav.ts",
  "components/dashboard/visibility-strip.tsx",
  "components/dashboard/calendar.tsx",
  "components/dashboard/calendar-model.ts",
  "components/dashboard/article-card.tsx",
  "components/dashboard/article-modal.tsx",
  "components/ui/inline-confirm.tsx",
  "components/growth/growth-view.tsx",
  "components/growth/growth-screen.tsx",
  "components/growth/period-switch.tsx",
  "components/visibility/places-line.tsx",
  "components/results/traffic-chart.tsx",
  "components/results/engine-citations.tsx",
  "components/results/article-results.tsx",
  "components/dashboard/index-status-line.tsx",
  "lib/analytics/index-status-display.ts",
  "lib/lifecycle/results.ts",
  "components/integrations/webhook-card.tsx",
  "components/integrations/wordpress-card.tsx",
  "app/auth/sign-up/page.tsx",
];

describe("customer screens carry no operator copy", () => {
  it.each(CUSTOMER_SCREENS)("%s", (file) => {
    const text = shown(file);
    expect(text).not.toMatch(/CITATIONS_GEMINI|PERPLEXITY_API_KEY|_API_KEY\b/);
    expect(text).not.toMatch(/paid call/i);
    expect(text).not.toMatch(/Est\. cost|est\. \$/);
    expect(text).not.toMatch(/costs? money|spends? money/i);
    expect(text).not.toMatch(/consent to spend/i);
    expect(text).not.toMatch(/\bPlacements\b/);
    expect(text).not.toContain("—");
  });

  it("uses prompts or questions, not queries, on the AI answers screens", () => {
    for (const file of CUSTOMER_SCREENS.filter((f) => f.includes("/growth/ai") || f.endsWith("ai-answers.tsx"))) {
      // Identifiers (data.queries, row.query, /api/visibility/queries) are
      // code: interpolations and paths are left out. A sentence in a string,
      // a template or JSX text that says "query" is copy.
      const text = shown(file).replace(/\$\{[^}]*\}/g, "");
      expect(text, file).not.toMatch(/"[A-Z][^"/]*\b[Qq]uer(y|ies)\b[^"/]*"/);
      expect(text, file).not.toMatch(/`[A-Z][^`/]*\b[Qq]uer(y|ies)\b[^`/]*`/);
      expect(text, file).not.toMatch(/>[^<{;=()]*\b[Qq]uer(y|ies)\b[^<{;=()]*</);
      for (const old of ["Add queries", "No queries yet", "Queries per run", "Remove query", "Query not found"]) {
        expect(text, file).not.toContain(old);
      }
    }
  });

  it("shows no placeholder that reads like someone's real data", () => {
    const all = CUSTOMER_SCREENS.map(shown).join("\n");
    expect(all).not.toContain("digital health");
    expect(all).not.toContain("best AI SEO tool");
    expect(all).not.toContain("342 Google impressions");
    expect(all).not.toContain("Self-taught dev");
  });
});

describe("no invented testimonial", () => {
  it("leaves the sign-up page with the form and the trial terms", () => {
    const page = shown("app/auth/sign-up/page.tsx");
    expect(page).not.toContain("Matteo Romano");
    expect(page).not.toContain("500%");
    expect(page).toContain("TRIAL_DAYS");
  });
});

describe("Keywords controls are real", () => {
  const page = shown("app/(app)/content/topics/page.tsx");

  it("opens the published article, or offers no button without a URL", () => {
    expect(page).not.toContain("TODO: View article");
    expect(page).toContain("href={keyword.published_url}");
    // The route reads the pool through lib/keywords/read.ts, which joins the link.
    expect(source("app/api/keywords/get/route.ts")).toContain("loadKeywords");
    expect(source("lib/keywords/read.ts")).toContain("published_url");
  });

  it("has no row kebab and no help button that do nothing", () => {
    expect(page).not.toContain("MoreVertical");
    expect(page).not.toContain("HelpCircle");
  });

  it("describes where keywords come from honestly, and labels estimates", () => {
    expect(page).not.toContain("in-depth research of your competitors");
    expect(page).toContain("niche, description and URL");
    expect(page.match(/\(est\.\)/g)).toHaveLength(3);
    expect(page).toContain("Model estimate, not measured data");
  });

  it("says outcomes on the page, never in a native dialog", () => {
    expect(page).not.toMatch(/\balert\(/);
    expect(page).not.toMatch(/\bconfirm\(/);
  });
});

describe("Account is read-only and true", () => {
  const page = shown("app/(app)/settings/account/page.tsx");

  it("has no save button without a handler, and no timezone the app does not use", () => {
    expect(page).not.toContain("Save Changes");
    expect(page).not.toContain("<form");
    expect(page).not.toContain("UTC");
  });

  it("does not tell an emailed-link account that Google manages its email", () => {
    expect(page).not.toContain("OAuth provider (Google)");
    expect(page).toContain("signInMethod(user)");
  });
});

describe("Team Members", () => {
  it("is gone: there was no team feature behind it", () => {
    expect(() => source("app/(app)/settings/team-members/page.tsx")).toThrow();
  });
});

describe("pluralize", () => {
  it("never writes '1 articles'", () => {
    expect(pluralize(1, "article")).toBe("1 article");
    expect(pluralize(0, "article")).toBe("0 articles");
    expect(pluralize(2, "keyword was", "keywords were")).toBe("2 keywords were");
  });
});
