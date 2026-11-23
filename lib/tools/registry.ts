import type { Tool } from "./tool";
import { ACCOUNT_TOOLS, DEFAULT_SITE_TOOLS } from "./account";
import { REPLIES_TOOLS } from "./replies";
import { TODAY_TOOLS } from "./today";
import { JOB_TOOLS } from "./jobs";
import { WRITE_KEYWORD_TOOLS } from "./write-keywords";
import { WRITE_CALENDAR_TOOLS } from "./write-calendar";
import { WRITE_VISIBILITY_TOOLS } from "./write-visibility";
import { WRITE_BUSINESS_TOOLS } from "./write-business";
import { WRITE_VOICE_TOOLS } from "./write-voice";
import { WRITE_INTEGRATION_TOOLS } from "./write-integrations";
import { ARTICLE_READ_TOOLS } from "./read-articles";
import { CONTENT_READ_TOOLS } from "./read-content";
import { KEYWORD_READ_TOOLS } from "./read-keywords";
import { VISIBILITY_READ_TOOLS } from "./read-visibility";
import { RESULTS_READ_TOOLS } from "./read-results";
import { GROWTH_READ_TOOLS } from "./read-growth";
import { BUSINESS_READ_TOOLS } from "./read-business";
import { INTEGRATION_READ_TOOLS } from "./read-integrations";
import { BILLING_READ_TOOLS } from "./read-billing";
import { ARTICLE_PRODUCE_TOOLS } from "./articles-produce";
import { PROVIDER_COMPARISON_TOOLS } from "./read-provider-comparison";
import { INDEX_STATUS_TOOLS } from "./index-status";
import { ARTICLE_PUSH_TOOLS } from "./article-pushes";

/**
 * The one registry (docs/ARCHITECTURE.md §4). The REST runner and the MCP
 * server read this list and nothing else, so a tool added here is on both
 * surfaces at once, with the same schema and the same checks.
 *
 * A domain adds its tools as one exported array (`REPLIES_TOOLS`), listed
 * below in the order the catalogue shows them.
 */

export interface ToolRegistry {
  list(): readonly Tool[];
  get(name: string): Tool | undefined;
}

/** A registry over `tools`. Two tools with one name is a definition error, refused at load. */
export function createRegistry(tools: readonly Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Two tools are named ${tool.name}.`);
    byName.set(tool.name, tool);
  }
  const listed = Object.freeze([...tools]);
  return {
    list: () => listed,
    get: (name) => byName.get(name),
  };
}

export const TOOLS: ToolRegistry = createRegistry([
  ...ACCOUNT_TOOLS,
  ...TODAY_TOOLS,
  ...REPLIES_TOOLS,
  ...JOB_TOOLS,
  ...WRITE_KEYWORD_TOOLS,
  ...WRITE_CALENDAR_TOOLS,
  ...WRITE_VISIBILITY_TOOLS,
  ...WRITE_BUSINESS_TOOLS,
  ...DEFAULT_SITE_TOOLS,
  ...WRITE_VOICE_TOOLS,
  ...WRITE_INTEGRATION_TOOLS,
  ...CONTENT_READ_TOOLS,
  ...ARTICLE_READ_TOOLS,
  ...KEYWORD_READ_TOOLS,
  ...VISIBILITY_READ_TOOLS,
  ...GROWTH_READ_TOOLS,
  ...RESULTS_READ_TOOLS,
  ...BUSINESS_READ_TOOLS,
  ...INTEGRATION_READ_TOOLS,
  ...BILLING_READ_TOOLS,
  ...ARTICLE_PRODUCE_TOOLS,
  ...PROVIDER_COMPARISON_TOOLS,
  ...INDEX_STATUS_TOOLS,
  ...ARTICLE_PUSH_TOOLS,
]);
