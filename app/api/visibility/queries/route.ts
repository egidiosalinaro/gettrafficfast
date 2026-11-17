import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { addPrompts, deletePrompt, updatePrompt } from "@/lib/visibility/manage";
import { AddQueriesInput, UpdateQueryInput } from "@/lib/visibility/queries";
import { listQueries } from "@/lib/visibility/read";

/**
 * The query set: list, add, edit, remove.
 *
 * All through the user's own session. `business_id` is never taken from the
 * body: it is the selected site, picked from what the user owns, so a forged
 * request cannot write into another site's set. The writes are the functions
 * the visibility tools call (lib/visibility/manage.ts); the list is the read
 * `list_prompts` calls (lib/visibility/read.ts).
 */

async function scope() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return { error: NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 }) };
  return { supabase, user, businessId };
}

function invalid(issues: { path: PropertyKey[]; message: string }[]) {
  return NextResponse.json(
    { error: issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") },
    { status: 400 }
  );
}

export async function GET() {
  const s = await scope();
  if ("error" in s) return s.error;

  // The same read as `list_prompts` (lib/visibility/read.ts).
  const listed = await listQueries(s.supabase, s.businessId);
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 500 });

  return NextResponse.json({ queries: listed.queries });
}

export async function POST(request: NextRequest) {
  const s = await scope();
  if ("error" in s) return s.error;

  const parsed = AddQueriesInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues);

  const result = await addPrompts({
    supabase: s.supabase,
    userId: s.user.id,
    businessId: s.businessId,
    queries: parsed.data.queries,
    source: parsed.data.source,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ added: result.added, duplicates: result.duplicates, queries: result.queries });
}

export async function PATCH(request: NextRequest) {
  const s = await scope();
  if ("error" in s) return s.error;

  const parsed = UpdateQueryInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues);

  const result = await updatePrompt({
    supabase: s.supabase,
    userId: s.user.id,
    businessId: s.businessId,
    id: parsed.data.id,
    patch: {
      query: parsed.data.query,
      cluster: parsed.data.cluster,
      intent: parsed.data.intent,
      enabled: parsed.data.enabled,
    },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ query: result.query });
}

export async function DELETE(request: NextRequest) {
  const s = await scope();
  if ("error" in s) return s.error;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  // Probes keep their history (query_id goes null); only the wording leaves
  // the set.
  const result = await deletePrompt({ supabase: s.supabase, userId: s.user.id, businessId: s.businessId, id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ deleted: result.deleted });
}
