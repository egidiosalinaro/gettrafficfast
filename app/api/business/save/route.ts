import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { businessFieldsRefusal, saveBusiness } from "@/lib/business/save";
import { DEFAULT_CONTENT_LANGUAGE, isContentLanguage } from "@/lib/content-language";
import {
  BUSINESS_COOKIE,
  BUSINESS_COOKIE_MAX_AGE,
  listBusinesses,
  selectedBusinessId,
} from "@/lib/tenancy";

/**
 * Create or update a site.
 *
 * `createNew` is what makes a second site possible: without it this endpoint
 * updates the selected business, with it a new row is inserted and immediately
 * becomes the selection, so the person lands in the site they just created
 * rather than in the one they were looking at before.
 *
 * The is_locked rule is unchanged and per business: once a site's URL has been
 * saved it is frozen, because the whole content history of that business was
 * generated for that domain. The save itself is `saveBusiness`
 * (lib/business/save.ts), which the create_business and update_business tools
 * call too.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      name,
      websiteUrl,
      niche,
      description,
      sitemapUrl,
      blogUrl,
      createNew,
    } = body;
    const contentLanguage = isContentLanguage(body.contentLanguage)
      ? body.contentLanguage
      : DEFAULT_CONTENT_LANGUAGE;

    const invalid = businessFieldsRefusal(name, websiteUrl);
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }

    const businesses = await listBusinesses(supabase, user.id);
    const targetId = createNew ? null : await selectedBusinessId(supabase, user.id);

    const result = await saveBusiness({
      supabase,
      userId: user.id,
      targetId,
      fields: { name, websiteUrl, niche, description, sitemapUrl, blogUrl, contentLanguage },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // A site just created becomes the selected one, including the very first.
    const data = result.business;
    if (data?.id && (createNew || businesses.length === 0)) {
      const store = await cookies();
      store.set(BUSINESS_COOKIE, data.id as string, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: BUSINESS_COOKIE_MAX_AGE,
      });
    }

    return NextResponse.json({ success: true, business: data });
  } catch (error) {
    console.error("Error in save endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
