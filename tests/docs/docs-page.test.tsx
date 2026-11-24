import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DOC_SECTIONS, DocsContent, DocsToc } from "@/components/docs/docs-content";
import { docToolGroups } from "@/components/docs/tool-groups";
import { docsLimits } from "@/components/docs/docs-limits";
import { TOOLS } from "@/lib/tools/registry";
import { TOOL_LIMITS } from "@/lib/tools/usage";
import { DAILY_CORRECTION_CAP, DAILY_DRAFT_CAP } from "@/lib/paid-access";
import { CONTACT_EMAIL } from "@/lib/site";
import { HINTS } from "@/lib/api-errors";
import { LEGACY_REDIRECTS } from "@/lib/legacy-redirects";
import { CRAWLABLE_PREFIXES, isPublicPath } from "@/lib/public-paths";
import robots from "@/app/robots";
import { PROMPTS } from "@/lib/tools/prompts";
import { AI_ANSWER_CRAWLERS, AI_TRAINING_CRAWLERS, wordpressRobotsSnippet } from "@/lib/ai-crawlers";

/**
 * The public docs (`/docs`), which replaced the in-app Help and Contact on
 * 2026-11-14. Pinned: every section has its anchor, the tool list is the
 * registry (each tool once, none invented), the limits are the code's, the
 * measurement rules are stated, the old paths land on the right anchor, and
 * the page is open to strangers and crawlers.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const groups = docToolGroups(TOOLS.list());
const render = (engines: Array<"gemini" | "perplexity"> = ["gemini", "perplexity"]) =>
  renderToStaticMarkup(<DocsContent engines={engines} toolGroups={groups} limits={docsLimits()} />);
/** The text a reader sees: tags out, entities read. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

describe("the sections", () => {
  it("each has its anchor, and the table of contents links to every one", () => {
    const html = render();
    const toc = renderToStaticMarkup(<DocsToc />);
    for (const section of DOC_SECTIONS) {
      expect(html, section.id).toContain(`id="${section.id}"`);
      expect(toc).toContain(`href="#${section.id}"`);
    }
    expect((toc.match(/min-h-\[44px\]/g) ?? []).length).toBe(DOC_SECTIONS.length);
  });

  it("has the anchors the hints and redirects point at", () => {
    const html = render();
    for (const anchor of ["contact", "how-we-measure", "limits", "claude", "tools", "api"]) {
      expect(html).toContain(`id="${anchor}"`);
    }
    expect(HINTS.keyCaps).toContain("/docs#limits");
    expect(HINTS.accountCaps).toContain("/docs#limits");
  });
});

describe("the tools", () => {
  it("are the registry's, each listed once, nothing added", () => {
    const listed = groups.flatMap((group) => group.tools.map((tool) => tool.name));
    const registry = TOOLS.list().map((tool) => tool.name);
    expect([...listed].sort()).toEqual([...registry].sort());
    expect(new Set(listed).size).toBe(listed.length);

    const html = render();
    for (const tool of TOOLS.list()) {
      expect(html).toContain(`>${tool.name}</code>`);
    }
    expect(text(html)).toContain(`${registry.length} tools today`);
  });

  it("puts each tool in the group of what it can do", () => {
    const byGroup = Object.fromEntries(groups.map((group) => [group.id, group.tools.map((tool) => tool.name)]));
    expect([...byGroup.publish].sort()).toEqual(["post_on_x", "publish_article"]);
    for (const tool of TOOLS.list()) {
      const expected = tool.scope === "publish" ? "publish" : tool.paid ? "spend" : tool.scope;
      expect(byGroup[expected], tool.name).toContain(tool.name);
    }
  });

  it("groups a list it is given, and leaves an empty group out", () => {
    expect(
      docToolGroups([
        { name: "a_read", title: "A", scope: "read", paid: false },
        { name: "b_paid", title: "B", scope: "write", paid: true },
      ]).map((group) => [group.id, group.tools.map((tool) => tool.name)])
    ).toEqual([
      ["read", ["a_read"]],
      ["spend", ["b_paid"]],
    ]);
  });
});

describe("what the docs say", () => {
  it("gives the connector address, the Claude Code line and the contact inbox", () => {
    const shown = text(render());
    expect(shown).toContain("https://gettrafficfa.st/api/mcp");
    expect(shown).toContain(
      'claude mcp add --transport http gettrafficfast https://gettrafficfa.st/api/mcp --header "Authorization: Bearer gtf_…"'
    );
    expect(shown).toContain("Customize → Connectors");
    expect(shown).toContain("https://gettrafficfa.st/api/v1/tools");
    expect(render()).toContain(`href="mailto:${CONTACT_EMAIL}"`);
  });

  it("states the measurement rules: sampled, per engine, counts under 10, not measured is not 0", () => {
    const shown = text(render());
    expect(shown).toContain("GTF samples");
    expect(shown).toContain("Per engine, never averaged");
    expect(shown).toContain("Under 10 readable answers, a count");
    expect(shown).toContain("Not measured means GTF has not asked yet. 0 means it asked and you were not cited.");
    expect(shown).toContain("read once a day");
    expect(shown).toContain("running totals");
  });

  it("names only the engines switched on, and says so when none is", () => {
    expect(text(render(["perplexity"]))).toContain("The engines asked today: Perplexity.");
    expect(text(render([]))).toContain("No answer engine is switched on right now");
  });

  it("states the limits the code holds", () => {
    const shown = text(render());
    expect(shown).toContain(`${TOOL_LIMITS.perMinute} calls a minute`);
    for (const [tool, cap] of Object.entries(TOOL_LIMITS.dailyByTool)) expect(shown).toContain(`${tool} ${cap}`);
    expect(shown).toContain(`${DAILY_DRAFT_CAP} reply drafts and ${DAILY_CORRECTION_CAP} fixes a day`);
  });

  it("states the limit for AI work in units, never as a spend limit the customer sets", () => {
    const shown = text(render());
    expect(shown).toContain("A daily limit on AI work overall");
    expect(shown).toContain("get_plan_usage");
    expect(shown).toContain("nothing here is billed per use");
    expect(shown).not.toMatch(/spend limit|raise the daily/i);
  });

  it("lists the MCP prompts the server serves, and how to run them from Claude", () => {
    const html = render();
    const shown = text(html);
    expect(html).toContain('id="routine"');
    expect(shown).toContain("Run your day from Claude");
    for (const prompt of PROMPTS) expect(html).toContain(`>${prompt.name}</code>`);
    expect(shown).toContain("/mcp__gettrafficfast__daily_routine Europe/Berlin");
    expect(shown).toContain("Neither GTF nor Claude ever posts on its own.");
  });

  it("says what never happens: no posting, no product or link in a reply, no check or extra spend started unasked", () => {
    const shown = text(render());
    expect(shown).toContain("GTF never posts on its own.");
    expect(shown).toContain("Post on X.");
    expect(shown).toContain("A reply names no product and carries no link.");
    expect(shown).toContain("Start a check of the AI answer engines without asking you");
    // On by default since 2026-11-24: nothing to turn on.
    expect(shown).toContain("Autopilot, images and the weekly check are already on.");
    expect(shown).toContain("Autopilot is on for every site, with nothing to turn on.");
    expect(shown).not.toMatch(/off until you turn/i);
  });

  it("tells a customer how to be readable by AI answer engines, without promising a citation", () => {
    const html = render();
    const shown = text(html);
    expect(html).toContain('id="ai-crawlers"');
    expect(shown).toContain("Be readable by AI answer engines");
    // The snippet is the shared list, so the docs cannot name a crawler robots.txt does not.
    expect(shown).toContain(wordpressRobotsSnippet().replace(/\s+/g, " "));
    for (const name of [...AI_ANSWER_CRAWLERS, ...AI_TRAINING_CRAWLERS]) expect(shown).toContain(name);
    expect(shown).toContain("llms.txt");
    expect(shown).toContain("They do not make an engine cite you");
    expect(html).toContain('href="#ai-answers"');
  });

  it("quotes no result of GetTrafficFast's own, and no em dash", () => {
    const shown = text(render());
    expect(shown).not.toMatch(/\b217\b|from 7 to/);
    expect(shown).not.toContain("—");
  });
});

describe("the public page", () => {
  it("is open to strangers and crawlers, and in the sitemap", () => {
    expect(CRAWLABLE_PREFIXES).toContain("/docs");
    expect(isPublicPath("/docs")).toBe(true);
    const rule = (() => {
      const body = robots();
      return Array.isArray(body.rules) ? body.rules[0] : body.rules;
    })();
    expect(rule?.allow).toEqual(expect.arrayContaining(["/docs"]));
    expect(source("app/sitemap.ts")).toContain("${baseUrl}/docs");
  });

  it("is linked from the public header and footer", () => {
    expect(source("components/landing/header.tsx")).toContain('href="/docs"');
    expect(source("components/landing/footer.tsx")).toContain('href="/docs"');
  });
});

describe("Help and Contact, retired", () => {
  it("redirect to the docs, Contact to its section", () => {
    expect(LEGACY_REDIRECTS).toEqual(
      expect.arrayContaining([
        { source: "/help", destination: "/docs", permanent: false },
        { source: "/dashboard/help", destination: "/docs", permanent: false },
        { source: "/dashboard/contact", destination: "/docs#contact", permanent: false },
      ])
    );
  });

  it("are gone from the app, with the component they shared", () => {
    for (const file of [
      "app/(app)/help/page.tsx",
      "app/(app)/dashboard/help/page.tsx",
      "app/(app)/dashboard/contact/page.tsx",
      "components/help/help-content.tsx",
    ]) {
      expect(existsSync(path.join(root, file)), file).toBe(false);
    }
  });
});
