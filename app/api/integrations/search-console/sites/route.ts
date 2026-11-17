import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadSearchConsoleProperties } from "@/lib/analytics/properties";
import { selectedBusiness } from "@/lib/tenancy";

/** The properties the customer's grant can read, so they can pick one. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const business = await selectedBusiness(supabase, user.id);
    if (!business) return NextResponse.json({ sites: [], connected: false });

    // The same read as `list_search_console_properties` (lib/analytics/properties.ts).
    return NextResponse.json(await loadSearchConsoleProperties(createAdminClient(), business));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
