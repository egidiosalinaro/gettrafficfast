import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { disconnectXAccount } from "@/lib/integrations/x-posting";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Disconnects the selected site's X account: the tokens are revoked at X and
 * the row is deleted at once. Replies already posted stay on X and in the
 * inbox. The same function the disconnect_x_account tool calls
 * (lib/integrations/x-posting.ts).
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json({ ok: true, disconnected: false });

  const result = await disconnectXAccount({ admin: createAdminClient(), userId: user.id, businessId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, disconnected: result.disconnected });
}
