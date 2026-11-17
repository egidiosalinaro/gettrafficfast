import { NextRequest, NextResponse } from "next/server";
import { resolveCaller } from "@/lib/api-auth";
import { apiError, apiErrorResponse } from "@/lib/api-errors";
import { runTool } from "@/lib/tools/runner";

/**
 * POST /api/v1/tools/:name — runs one registry tool (docs/API.md).
 *
 * Auth: the session cookie, or `Authorization: Bearer gtf_…`; the site:
 * the key's, `x-gtf-business`, or the selected one (lib/api-auth.ts). The
 * body is the tool's input as JSON (`{}` when it takes none). 200 answers
 * with the tool's output as the body; anything else is
 * `{ error: { code, message, hint? } }`.
 *
 * maxDuration covers the longest tool: a draft job runs up to 105 s, and the
 * call keeps the function alive until it ends even when it answered after
 * waiting 25 s.
 */
export const maxDuration = 120;

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const resolved = await resolveCaller(request);
  if (!resolved.ok) return apiErrorResponse(resolved.status, resolved.error);

  const text = await request.text();
  let input: unknown = {};
  if (text.trim()) {
    try {
      input = JSON.parse(text);
    } catch {
      return apiErrorResponse(400, apiError("invalid_input", "The body is not JSON.", "Send the tool's input as a JSON object, or {}."));
    }
  }

  const { name } = await context.params;
  const run = await runTool(resolved.caller, name, input);
  if (!run.ok) {
    // A key over its per-minute limit is told when to come back.
    const headers = run.retryAfterSeconds ? { "Retry-After": String(run.retryAfterSeconds) } : undefined;
    return apiErrorResponse(run.status, run.error, headers);
  }
  return NextResponse.json(run.output);
}
