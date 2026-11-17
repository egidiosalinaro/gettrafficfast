import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { disconnectIntegration, isDisconnectable } from "@/lib/integrations/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const type: unknown = body.type;
  if (!isDisconnectable(type)) {
    return NextResponse.json({ error: "Invalid integration type" }, { status: 400 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  // The same function the disconnect_integration tool calls (lib/integrations/manage.ts).
  const result = await disconnectIntegration({ supabase, userId: user.id, businessId, type });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
