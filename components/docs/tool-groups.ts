/**
 * The tools as the public docs list them (`/docs#tools`), grouped by what a
 * call can do to the account: read, change, start paid work, publish. The
 * list is the registry itself (`lib/tools/registry.ts`), passed in by the
 * page, so a tool added there is in the docs on the next deploy and a tool
 * removed is gone: there is no second list to forget.
 *
 * Pure: the page hands in `TOOLS.list()`, a test hands in anything.
 */

export interface DocTool {
  name: string;
  title: string;
}

export interface DocToolGroup {
  id: "read" | "write" | "spend" | "publish";
  title: string;
  /** One line under the title: what the group needs. */
  note: string;
  tools: DocTool[];
}

interface ToolLike {
  name: string;
  title: string;
  scope: "read" | "write" | "publish";
  paid: boolean;
}

const GROUPS: ReadonlyArray<Omit<DocToolGroup, "tools">> = [
  { id: "read", title: "Read", note: "Reads what is stored. The Read permission.", },
  { id: "write", title: "Change", note: "Changes your own data, no AI work. The Write permission.", },
  {
    id: "spend",
    title: "Start AI work",
    note: "A model call or a job that makes one, included in your plan within its daily limits. Write and Spend, and an active plan.",
  },
  {
    id: "publish",
    title: "Publish",
    note: "Puts an article live on your own connected site. The Publish permission.",
  },
];

function groupOf(tool: ToolLike): DocToolGroup["id"] {
  if (tool.scope === "publish") return "publish";
  if (tool.paid) return "spend";
  return tool.scope;
}

/** Every tool exactly once, in the registry's order within its group. Empty groups are left out. */
export function docToolGroups(tools: readonly ToolLike[]): DocToolGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    tools: tools.filter((tool) => groupOf(tool) === group.id).map(({ name, title }) => ({ name, title })),
  })).filter((group) => group.tools.length > 0);
}
