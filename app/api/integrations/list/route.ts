import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { listIntegrations } from "@/lib/integrations/read";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Destinations are per site: one account can publish Postwren to WordPress
  // and gettrafficfa.st to its own blog, and neither list should show the other.
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json({ integrations: [] });
  }

  // Encrypted credentials are stripped in lib/integrations/read.ts, the read
  // `list_integrations` shares.
  const listed = await listIntegrations(supabase, businessId);
  if (!listed.ok) {
    return NextResponse.json({ error: listed.error }, { status: 500 });
  }

  return NextResponse.json({ integrations: listed.integrations });
}
