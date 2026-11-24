import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { McpDocsContent } from "@/components/docs/mcp-content";
import { MCP_DOC_SECTIONS } from "@/components/docs/mcp-sections";
import { DocsToc, DocsContent } from "@/components/docs/docs-content";
import { areaOf, toolAreas } from "@/components/docs/tool-areas";
import { docToolGroups } from "@/components/docs/tool-groups";
import { docsLimits } from "@/components/docs/docs-limits";
import { ERROR_CODE_DOCS } from "@/components/docs/error-codes";
import { TOOLS } from "@/lib/tools/registry";
import { OWNER_TOOLS } from "@/lib/tools/owner";
import { PROMPTS } from "@/lib/tools/prompts";
import { API_ERROR_CODES } from "@/lib/api-errors";
import { PLAN_REQUIRED_MESSAGE } from "@/lib/paid-access";
import { TOOL_LIMITS } from "@/lib/tools/usage";
import { CONTACT_EMAIL } from "@/lib/site";
import { isPublicPath } from "@/lib/public-paths";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { DOC_SECTIONS } from "@/components/docs/sections";

/**
 * The public MCP reference (`/docs/mcp`), the page MCP registries link to.
 * Pinned: every section has its anchor; the tool list is the registry (each
 * tool once, none invented, the owner's tools never), grouped by area with
 * MCP's annotations; every error code is described; the plan refusal is
 * quoted from the code; the connection snippets carry the real address; the
 * page is public, in the sitemap and in /llms.txt, and linked from /docs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const areas = toolAreas(TOOLS.list());
const html = renderToStaticMarkup(<McpDocsContent areas={areas} limits={docsLimits()} />);
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/\s+/g, " ");

describe("/docs/mcp", () => {
  it("has every section's anchor, and its table of contents links to each", () => {
    const toc = renderToStaticMarkup(<DocsToc sections={MCP_DOC_SECTIONS} />);
    for (const section of MCP_DOC_SECTIONS) {
      expect(html, section.id).toContain(`id="${section.id}"`);
      expect(toc).toContain(`href="#${section.id}"`);
    }
  });

  it("lists every registry tool exactly once, by area, and never the owner's tools", () => {
    const listed = areas.flatMap((area) => area.tools.map((tool) => tool.name));
    expect([...listed].sort()).toEqual(TOOLS.list().map((tool) => tool.name).sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const tool of TOOLS.list()) expect(html, tool.name).toContain(`>${tool.name}</code>`);
    for (const tool of OWNER_TOOLS) expect(html).not.toContain(tool.name);
    expect(text).toContain(`${TOOLS.list().length} tools today`);
  });

  it("puts the tools in the areas a reader looks for them in", () => {
    expect(areaOf("draft_reply")).toBe("replies");
    expect(areaOf("get_today")).toBe("replies");
    expect(areaOf("update_voice_settings")).toBe("voice");
    expect(areaOf("add_about_you_fact")).toBe("voice");
    expect(areaOf("import_prompts_from_keywords")).toBe("visibility");
    expect(areaOf("schedule_keywords")).toBe("keywords");
    expect(areaOf("publish_article")).toBe("articles");
    expect(areaOf("sync_search_console")).toBe("google");
    expect(areaOf("disconnect_integration")).toBe("integrations");
    expect(areaOf("whoami")).toBe("account");
  });

  it("marks each tool with what MCP's annotations say about it", () => {
    const flags = Object.fromEntries(areas.flatMap((area) => area.tools.map((tool) => [tool.name, tool])));
    for (const tool of TOOLS.list()) {
      expect(flags[tool.name], tool.name).toMatchObject({
        readOnly: tool.scope === "read",
        destructive: tool.destructive === true,
        paid: tool.paid,
        publishes: tool.scope === "publish",
      });
    }
    expect(html).toContain("destructive");
    expect(html).toContain("read-only");
  });

  it("describes every error code the API and MCP answer, and nothing else", () => {
    expect(Object.keys(ERROR_CODE_DOCS).sort()).toEqual([...API_ERROR_CODES].sort());
    for (const code of API_ERROR_CODES) expect(html, code).toContain(`>${code}</code>`);
  });

  it("states the plan requirement and quotes the exact refusal an unpaid caller gets", () => {
    expect(text).toContain(PLAN_REQUIRED_MESSAGE);
    expect(text).toContain("subscription_required");
    expect(html).toContain('href="https://gettrafficfa.st/pricing"');
    expect(text).toContain("list the tools and list the prompts");
  });

  it("gives the address, the transport and a working snippet for each client", () => {
    expect(text).toContain("https://gettrafficfa.st/api/mcp");
    expect(text).toContain("Streamable HTTP");
    expect(text).toContain(
      'claude mcp add --transport http gettrafficfast https://gettrafficfa.st/api/mcp --header "Authorization: Bearer gtf_…"'
    );
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"servers"');
    expect(text).toContain('"type": "http"');
    expect(text).toContain("Customize → Connectors");
    expect(text).toContain("https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp");
  });

  it("names the permissions, the prompts, the limits, what never happens, privacy and support", () => {
    for (const scope of ["read", "write", "spend", "publish"]) expect(html).toContain(`>${scope}</code>`);
    for (const prompt of PROMPTS) expect(html).toContain(`>${prompt.name}</code>`);
    expect(text).toContain("/mcp__gettrafficfast__daily_routine Europe/Berlin");
    expect(text).toContain(`${TOOL_LIMITS.perMinute} calls a minute`);
    expect(text).toContain("Never posts on its own, and never on Reddit or any social site but X.");
    expect(text).toContain("post_on_x");
    expect(text).toContain("Never publishes without the Publish permission.");
    expect(html).toContain('href="/privacy-policy#api-and-mcp"');
    expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`);
  });

  it("states no price and no result of GetTrafficFast's own, and no em dash", () => {
    expect(text).not.toMatch(/\$\s?\d|€\s?\d|per month|\/month/i);
    expect(text).not.toContain("—");
  });

  it("is public, in the sitemap and /llms.txt, and linked from /docs", () => {
    expect(isPublicPath("/docs/mcp")).toBe(true);
    expect(source("app/sitemap.ts")).toContain("${baseUrl}/docs/mcp");
    const llms = buildLlmsTxt({
      siteUrl: "https://gettrafficfa.st",
      siteName: "GetTrafficFast",
      tagline: "t",
      summary: "s",
      docSections: DOC_SECTIONS,
      posts: [],
    });
    expect(llms).toContain("- [MCP server](https://gettrafficfa.st/docs/mcp): ");
    const docs = renderToStaticMarkup(
      <DocsContent engines={[]} toolGroups={docToolGroups(TOOLS.list())} limits={docsLimits()} />
    );
    expect(docs).toContain('href="/docs/mcp"');
  });
});
