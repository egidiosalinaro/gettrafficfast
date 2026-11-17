import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadBusiness } from "@/lib/business/read";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The selected site, not "the user's site": an account can hold several,
    // and .single() on user_id would now fail rather than pick one.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json({ business: null });
    }

    // The same read as `get_business` (lib/business/read.ts). No row is
    // not an error: a first-time user has none yet.
    const read = await loadBusiness(supabase, user.id, businessId);
    if (!read.ok) {
      console.error("Error fetching business:", read.error);
      return NextResponse.json(
        { error: "Failed to fetch business" },
        { status: 500 }
      );
    }

    return NextResponse.json({ business: read.business });
  } catch (error) {
    console.error("Error in get endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
