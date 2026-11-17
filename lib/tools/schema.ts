import { z } from "zod";
import type { ApiKeyScope } from "@/lib/api-keys";
import { needsSubscription, requiredScopes, type Tool } from "./tool";

/**
 * A tool as an external agent sees it: the same JSON Schemas for
 * `GET /api/v1/tools` and MCP's `tools/list`, generated from the Zod schemas
 * the runner validates with, so the description cannot drift from the check.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * `io: "input"` describes what a caller may send (a field with a default is
 * optional); `"output"` what comes back. `$schema` is dropped: MCP clients
 * do not need it, and it is the same on every tool.
 */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  delete json.$schema;
  return json;
}

export interface ToolDescription {
  name: string;
  title: string;
  description: string;
  /** Every scope a key needs to call it (`spend` included for a paid tool). */
  scopes: ApiKeyScope[];
  /** Costs money: needs the spend scope and an active subscription. */
  paid: boolean;
  /** Needs an active subscription (every paid tool does, and a few that spend nothing). */
  subscription: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export function describeTool(tool: Tool): ToolDescription {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    scopes: requiredScopes(tool),
    paid: tool.paid,
    subscription: needsSubscription(tool),
    inputSchema: jsonSchemaOf(tool.input, "input"),
    outputSchema: jsonSchemaOf(tool.output, "output"),
  };
}
