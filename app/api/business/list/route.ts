import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listBusinesses, selectedBusiness } from "@/lib/tenancy";

/** What the sidebar switcher needs: every site of this account, and which one is selected. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [businesses, selected] = await Promise.all([
      listBusinesses(supabase, user.id),
      selectedBusiness(supabase, user.id),
    ]);

    return NextResponse.json({ businesses, selectedId: selected?.id ?? null });
  } catch (error) {
    console.error("Error listing businesses:", error);
    return NextResponse.json({ error: "Failed to list sites" }, { status: 500 });
  }
}
