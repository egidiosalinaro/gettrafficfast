import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPolicy from "@/app/privacy-policy/page";
import TermsAndConditions from "@/app/terms-and-conditions/page";
import { formatLegalDate, LEGAL_VAT_NUMBER, SERVICE_PROVIDERS } from "@/lib/legal";
import { CONTACT_EMAIL } from "@/lib/site";
import { TOOL_CALLS_RETENTION_DAYS } from "@/lib/tools/retention";

/**
 * The two legal pages, rendered. Pinned: the fixed date, the operator, no
 * VAT line while the number is empty, an anchor per section, every service
 * provider named, the Limited Use disclosure, and the copy has no em dash.
 */

const privacy = renderToStaticMarkup(<PrivacyPolicy />);
const terms = renderToStaticMarkup(<TermsAndConditions />);

const PRIVACY_ANCHORS = [
  "controller",
  "data-we-collect",
  "purposes-and-legal-bases",
  "ai-processing",
  "google-data",
  "api-and-mcp",
  "public-posts",
  "service-providers",
  "international-transfers",
  "retention",
  "security",
  "your-rights",
  "cookies",
  "children",
  "changes",
  "contact",
];

const TERMS_ANCHORS = [
  "provider",
  "agreement",
  "the-service",
  "accounts",
  "billing",
  "acceptable-use",
  "api-and-automated-access",
  "ai-output",
  "intellectual-property",
  "availability",
  "warranty",
  "liability",
  "termination",
  "changes",
  "law",
  "contact",
];

describe("both pages", () => {
  it.each([
    ["privacy", privacy],
    ["terms", terms],
  ])("%s: fixed date, operator, contact, no VAT line while empty, no em dash", (_, html) => {
    expect(html).toContain(`Last updated: <time dateTime="2026-11-24">${formatLegalDate()}</time>`);
    expect(html).toContain("Egidio Salinaro");
    expect(html).toContain("Via Baccina 87, 00184 Roma, Italy");
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
    if (LEGAL_VAT_NUMBER.trim() === "") {
      expect(html).not.toContain("Partita IVA");
      expect(html).not.toContain("VAT number");
    }
    expect(html).not.toContain("—");
  });
});

describe("privacy policy", () => {
  it("has an anchor per section, listed on the page", () => {
    for (const id of PRIVACY_ANCHORS) {
      expect(privacy).toContain(`id="${id}"`);
      expect(privacy).toContain(`href="#${id}"`);
    }
  });

  it("names every service provider and carries the Limited Use disclosure", () => {
    for (const provider of SERVICE_PROVIDERS) expect(privacy).toContain(provider.name.replace(/&/g, "&amp;"));
    expect(privacy).toContain("including the Limited Use requirements");
    expect(privacy).toContain("api-services-user-data-policy");
  });

  it("states the call log retention from the constant the sweep uses, and the Garante", () => {
    expect(privacy).toContain(`kept ${TOOL_CALLS_RETENTION_DAYS} days`);
    expect(privacy).toContain("Garante per la protezione dei dati personali");
  });
});

describe("terms", () => {
  it("has an anchor per section, listed on the page", () => {
    for (const id of TERMS_ANCHORS) {
      expect(terms).toContain(`id="${id}"`);
      expect(terms).toContain(`href="#${id}"`);
    }
  });

  it("says GTF never posts, keys are authorisation, Italian law, no prices", () => {
    expect(terms).toContain("GTF never posts");
    expect(terms).toContain("is your authorisation for that key or app to act on your account");
    expect(terms).toContain("governed by Italian law");
    expect(terms).toContain("courts of Rome");
    expect(terms).not.toMatch(/\$\s?\d|€\s?\d|per month|\/month/i);
  });
});
