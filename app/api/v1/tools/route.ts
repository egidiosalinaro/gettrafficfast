import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import { describeTool } from "@/lib/tools/schema";
import { TOOLS } from "@/lib/tools/registry";

/**
 * GET /api/v1/tools — the catalogue: every tool with its title,
 * description, required scopes, whether it is paid, and the JSON Schemas of
 * its input and output (the ones the runner validates with). Public: it
 * describes the API, it reads no one's data.
 */
export function GET() {
  return NextResponse.json({
    tools: TOOLS.list().map(describeTool),
    run: `${SITE_URL}/api/v1/tools/{name}`,
    mcp: `${SITE_URL}/api/mcp`,
  });
}
