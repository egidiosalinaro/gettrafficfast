/**
 * /llms.txt for gettrafficfa.st: a plain-text map of the public site in the
 * format proposed at llmstxt.org (an H1, a one-line summary in a quote, a
 * paragraph, then H2 sections of `- [name](url): note` lines).
 *
 * Pure: the route (app/llms.txt/route.ts) reads the posts and the docs
 * sections and hands them in, so what the file says is testable without a
 * database. Every line is built from something the site already publishes:
 * the summary is the docs' opening (lib/site.ts), the docs links are the
 * docs' own sections, the posts are the rows the blog renders with their
 * stored meta description. Nothing about GetTrafficFast's own results is
 * stated (the owner's rule, 2026-11-12).
 */

/** Newest first, at most this many: the file is a map, not an archive. */
export const LLMS_TXT_POST_CAP = 50;

/** A meta description is about 160 characters; a stored one far longer is cut here. */
const NOTE_MAX = 300;

export interface LlmsTxtPost {
  slug: string;
  title: string;
  /** The stored meta description (the excerpt when the delivery had none). */
  metaDescription: string;
}

export interface LlmsTxtInput {
  siteUrl: string;
  siteName: string;
  /** One line, under the title. */
  tagline: string;
  /** The paragraph that says what the product is. */
  summary: string;
  docSections: ReadonlyArray<{ id: string; title: string }>;
  /** Published blog posts, newest first; null when they could not be read. */
  posts: ReadonlyArray<LlmsTxtPost> | null;
}

/** Every run of whitespace (a newline included) is one space: a line stays one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Link text: brackets and backslashes escaped, so a title cannot close the link. */
function linkText(text: string): string {
  return oneLine(text).replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * A link target: a slug is put through encodeURIComponent, which leaves
 * parentheses alone, and a ")" would end the Markdown link early.
 */
function pathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** One line, at most NOTE_MAX characters, cut at a word with an ellipsis. */
function note(text: string): string {
  const line = oneLine(text);
  if (line.length <= NOTE_MAX) return line;
  const cut = line.slice(0, NOTE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function item(name: string, url: string, description?: string): string {
  const detail = description ? note(description) : "";
  return `- [${linkText(name)}](${url})${detail ? `: ${detail}` : ""}`;
}

/** The posts worth listing: a row with no slug or no title has no page to point at. */
function listable(posts: ReadonlyArray<LlmsTxtPost>): LlmsTxtPost[] {
  return posts.filter((post) => oneLine(post.slug ?? "") && oneLine(post.title ?? "")).slice(0, LLMS_TXT_POST_CAP);
}

export function buildLlmsTxt(input: LlmsTxtInput): string {
  const site = input.siteUrl.replace(/\/+$/, "");
  const lines: string[] = [`# ${oneLine(input.siteName)}`, "", `> ${oneLine(input.tagline)}`, "", oneLine(input.summary), ""];

  lines.push("## Docs", "");
  for (const section of input.docSections) {
    lines.push(item(section.title, `${site}/docs#${pathSegment(section.id)}`));
  }
  // The MCP reference has its own page: the address MCP registries link to.
  lines.push(
    item(
      "MCP server",
      `${site}/docs/mcp`,
      "Connect GetTrafficFast from Claude, ChatGPT, Cursor, VS Code or any MCP client: sign-in, API keys, permissions, prompts, every tool, limits and error codes. Needs an active plan."
    )
  );
  lines.push("");

  lines.push("## Product", "");
  lines.push(item("Pricing", `${site}/pricing`, "The plan, its price and what it includes."));
  lines.push("");

  lines.push("## Blog", "");
  lines.push(item("Blog", `${site}/blog`, "Articles GetTrafficFast researched, wrote and published for its own site."));
  for (const post of listable(input.posts ?? [])) {
    lines.push(item(post.title, `${site}/blog/${pathSegment(oneLine(post.slug))}`, post.metaDescription));
  }
  lines.push("");

  return lines.join("\n");
}
