/**
 * The tools as the MCP reference lists them (`/docs/mcp#tools`): grouped by
 * the part of the product they work on, one line each, with what MCP's
 * annotations say about them (read-only, destructive, paid, reaches the
 * customer's live site). The list is the registry itself, handed in by the
 * page, so a tool added there is on the page on the next deploy; a test
 * holds the page to the registry (tests/docs/mcp-page.test.tsx).
 *
 * The area is read from the tool's name by the rules below, in order; a
 * name no rule matches lands in "Account and sites" rather than being left
 * out. Pure: no registry import, so a test can hand in anything.
 */

export interface AreaTool {
  name: string;
  title: string;
  readOnly: boolean;
  destructive: boolean;
  paid: boolean;
  publishes: boolean;
}

export interface ToolArea {
  id: string;
  title: string;
  note: string;
  tools: AreaTool[];
}

interface ToolLike {
  name: string;
  title: string;
  scope: "read" | "write" | "publish";
  paid: boolean;
  destructive?: boolean;
}

const AREAS: ReadonlyArray<{ id: string; title: string; note: string; match: RegExp }> = [
  {
    id: "voice",
    title: "Voice and facts",
    note: "How replies sound, and the true facts they may use.",
    match: /voice|about_you|draft_feedback|feedback_to_notes/,
  },
  {
    id: "replies",
    title: "Today and replies",
    note: "The day's list, conversations worth answering, drafts, and what you posted.",
    match: /^get_today|reply|x_post/,
  },
  {
    id: "visibility",
    title: "AI visibility",
    note: "The questions asked of AI answer engines, the runs, and what the answers cited.",
    match: /prompt|visibility|ai_answers|find_places/,
  },
  {
    id: "keywords",
    title: "Keywords and topics",
    note: "The topics coming next, and putting them on the calendar.",
    match: /keyword|question_ideas/,
  },
  {
    id: "articles",
    title: "Articles and calendar",
    note: "The calendar, writing, publishing to your own site, and pushing older articles.",
    match: /article|^get_content$|^list_calendar$|^list_deliveries$/,
  },
  {
    id: "google",
    title: "Google and results",
    note: "Search Console, indexing, and the week's numbers.",
    match: /search_console|index_status|inspect_url|^get_growth$|^get_results$/,
  },
  {
    id: "integrations",
    title: "Connections",
    note: "Where articles are delivered. Connecting one needs a password or a secret, so it is done signed in.",
    match: /integration/,
  },
  {
    id: "account",
    title: "Account and sites",
    note: "Who you are, your sites, settings, the plan's usage, and jobs.",
    match: /.*/,
  },
];

/** The area id a tool's name falls in. */
export function areaOf(name: string): string {
  return (AREAS.find((area) => area.match.test(name)) ?? AREAS[AREAS.length - 1]).id;
}

/** Every tool exactly once, in the registry's order within its area. Empty areas are left out. */
export function toolAreas(tools: readonly ToolLike[]): ToolArea[] {
  return AREAS.map(({ id, title, note }) => ({
    id,
    title,
    note,
    tools: tools
      .filter((tool) => areaOf(tool.name) === id)
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        readOnly: tool.scope === "read",
        destructive: tool.destructive === true,
        paid: tool.paid,
        publishes: tool.scope === "publish",
      })),
  })).filter((area) => area.tools.length > 0);
}
