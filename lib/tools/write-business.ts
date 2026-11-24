import { z } from "zod";
import { AutomationSettings } from "@/lib/automation/settings";
import { businessFieldsRefusal, saveBusiness, type SaveBusinessResult } from "@/lib/business/save";
import { saveAutomationSettings, saveMediaSettings } from "@/lib/business/save-settings";
import { DEFAULT_CONTENT_LANGUAGE, isContentLanguage, SUPPORTED_CONTENT_LANGUAGES } from "@/lib/content-language";
import { MediaSettings, maxImagesPerArticle } from "@/lib/media/settings";
import { analyzeSite } from "@/lib/research/analyze-site";
import { WebsiteAnalysis } from "@/lib/research/website";
import { BUSINESS_HEADER } from "@/lib/api-auth";
import { defineTool, ToolError, type ToolContext } from "./tool";
import {
  changesOf,
  Confirm,
  libRefusal,
  partialOf,
  requireConfirmation,
  requireScopes,
  storedSettings,
  strictSettings,
} from "./write-guards";

/**
 * The site's own settings as tools (Settings → Business, Automation, Images
 * & video). Each handler calls the function the settings route calls
 * (lib/business/, lib/research/analyze-site.ts).
 *
 * A settings tool takes only the fields to change and merges them onto what
 * is stored, then validates the whole with the route's strict schema: an
 * agent that sends `{ enabled: true }` must not reset the rest to defaults.
 *
 * Autopilot, Push page 3 and images are on by default since 2026-11-24
 * (product features are on). Setting one back on after the person turned it
 * off is not asked again; it still needs the scopes a key must hold for what
 * it does (spend, and publish for autopilot). Raising the in-article image
 * cap above what the site has is a choice to spend more: it needs
 * `confirm: true` (AGENTS.md §12).
 */

type Row = Record<string, unknown>;

const LANGUAGES = SUPPORTED_CONTENT_LANGUAGES.map((l) => l.code) as [string, ...string[]];

export const BusinessRecord = z.object({
  id: z.string(),
  name: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  niche: z.string().nullable(),
  description: z.string().nullable(),
  sitemapUrl: z.string().nullable(),
  blogUrl: z.string().nullable(),
  contentLanguage: z.string().nullable(),
  locked: z.boolean().describe("True once saved: the name and address can no longer change."),
});

function mapBusiness(row: Row): z.infer<typeof BusinessRecord> {
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    niche: (row.niche as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    sitemapUrl: (row.sitemap_url as string | null) ?? null,
    blogUrl: (row.blog_url as string | null) ?? null,
    contentLanguage: (row.content_language as string | null) ?? null,
    locked: row.is_locked === true,
  };
}

const Url = z.string().trim().min(1).max(2000);
const Optional = (schema: z.ZodString) => schema.nullable().optional();

const ProfileFields = {
  niche: Optional(z.string().trim().max(200)),
  description: Optional(z.string().trim().max(2000)),
  sitemapUrl: Optional(Url),
  blogUrl: Optional(Url),
  contentLanguage: z.enum(LANGUAGES).optional().describe("The language articles and keywords are written in."),
};

function saveRefusal(result: Extract<SaveBusinessResult, { ok: false }>): Error {
  if (result.code === "locked") {
    return new ToolError("invalid_state", result.error, 409, "create_business adds another site; the name and address of this one stay.");
  }
  return libRefusal(result);
}

/**
 * The key, or the app connected over OAuth, is limited to one site: it may
 * change that site, never add another.
 */
async function siteLimitedKey(ctx: ToolContext): Promise<boolean> {
  // A grant with no site recorded is treated as limited, like an unreadable key.
  if (ctx.caller.via === "oauth") return ctx.caller.oauth?.siteLimited ?? true;
  if (ctx.caller.via !== "api_key" || !ctx.caller.keyId) return false;
  const { data } = await ctx.client.from("api_keys").select("business_id").eq("id", ctx.caller.keyId).maybeSingle();
  // Unreadable is treated as limited: a key must not gain a site it may not have.
  return !data || Boolean(data.business_id);
}

export const createBusiness = defineTool({
  name: "create_business",
  title: "Add a site",
  description: `Adds a site (business) to the account: its name and address, locked from the first save because every keyword, article and measurement is made for that address, plus its profile. Other tools then act on it when called with the ${BUSINESS_HEADER} header set to its id. A key limited to one site cannot add another.`,
  input: z.object({
    name: z.string().trim().min(1).max(200),
    websiteUrl: Url.describe("The site's address, like https://example.com."),
    ...ProfileFields,
  }),
  output: z.object({ business: BusinessRecord, hint: z.string() }),
  scope: "write",
  paid: false,
  needsBusiness: false,
  async handler(ctx, input) {
    if (await siteLimitedKey(ctx)) {
      throw new ToolError(
        "forbidden_business",
        "This key is limited to one site and cannot add another.",
        403,
        "Use a key for every site, or add the site in Settings → Business."
      );
    }
    const invalid = businessFieldsRefusal(input.name, input.websiteUrl);
    if (invalid) throw new ToolError("invalid_input", invalid, 400);
    const result = await saveBusiness({
      supabase: ctx.client,
      userId: ctx.userId,
      targetId: null,
      fields: {
        name: input.name,
        websiteUrl: input.websiteUrl,
        niche: input.niche,
        description: input.description,
        sitemapUrl: input.sitemapUrl,
        blogUrl: input.blogUrl,
        contentLanguage: isContentLanguage(input.contentLanguage) ? input.contentLanguage : DEFAULT_CONTENT_LANGUAGE,
      },
    });
    if (!result.ok) throw saveRefusal(result);
    const business = mapBusiness(result.business);
    return { business, hint: `Send ${BUSINESS_HEADER}: ${business.id} to act on this site.` };
  },
});

export const updateBusiness = defineTool({
  name: "update_business",
  title: "Update the site",
  description:
    "Changes this site's profile: niche, description, sitemap and blog addresses, content language. Fields left out stay as they are. The name and address are locked once saved: a different one is refused with the reason, never ignored.",
  input: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    websiteUrl: Url.optional(),
    ...ProfileFields,
  }),
  output: z.object({ business: BusinessRecord }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const { data: stored } = await ctx.client
      .from("businesses")
      .select("id, name, website_url, niche, description, sitemap_url, blog_url, content_language")
      .eq("id", ctx.businessId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (!stored) throw new ToolError("not_found", "This site is no longer on the account.", 404);
    const pick = <T>(given: T | undefined, current: unknown) => (given !== undefined ? given : (current as T));
    const fields = {
      name: pick(input.name, stored.name) as string,
      websiteUrl: pick(input.websiteUrl, stored.website_url) as string,
      niche: pick(input.niche, stored.niche),
      description: pick(input.description, stored.description),
      sitemapUrl: pick(input.sitemapUrl, stored.sitemap_url),
      blogUrl: pick(input.blogUrl, stored.blog_url),
      contentLanguage: isContentLanguage(input.contentLanguage)
        ? input.contentLanguage
        : isContentLanguage(stored.content_language)
          ? stored.content_language
          : DEFAULT_CONTENT_LANGUAGE,
    };
    const invalid = businessFieldsRefusal(fields.name, fields.websiteUrl);
    if (invalid) throw new ToolError("invalid_input", invalid, 400);
    const result = await saveBusiness({
      supabase: ctx.client,
      userId: ctx.userId,
      targetId: ctx.businessId,
      fields,
      refuseLockedChanges: true,
    });
    if (!result.ok) throw saveRefusal(result);
    return { business: mapBusiness(result.business) };
  },
});

export const analyzeWebsiteTool = defineTool({
  name: "analyze_website",
  title: "Analyse a website",
  description:
    "Reads a website's home page (public addresses only) and drafts its profile: niche, description, sitemap and blog addresses (null when not found, never guessed). One model call. Nothing is saved: pass what to keep to update_business or create_business. Without websiteUrl, analyses this site.",
  input: z.object({
    websiteUrl: Url.optional(),
    contentLanguage: z.enum(LANGUAGES).optional().describe("The language to write the profile in; the site's own by default."),
  }),
  output: z.object({ websiteUrl: z.string(), analysis: WebsiteAnalysis }),
  scope: "write",
  paid: true,
  needsBusiness: false,
  async handler(ctx, input) {
    const { data: site } = ctx.businessId
      ? await ctx.client
          .from("businesses")
          .select("website_url, content_language")
          .eq("id", ctx.businessId)
          .eq("user_id", ctx.userId)
          .maybeSingle()
      : { data: null };
    const websiteUrl = input.websiteUrl ?? (site?.website_url as string | null | undefined) ?? null;
    if (!websiteUrl) throw new ToolError("invalid_input", "Website URL is required", 400);
    const language = input.contentLanguage ?? site?.content_language;
    const result = await analyzeSite({
      admin: ctx.admin,
      websiteUrl,
      contentLanguage: isContentLanguage(language) ? language : DEFAULT_CONTENT_LANGUAGE,
      source: "tool.analyze_website",
    });
    if (!result.ok) throw libRefusal(result);
    return { websiteUrl, analysis: result.analysis };
  },
});

export const updateAutomationSettings = defineTool({
  name: "update_automation_settings",
  title: "Change autopilot",
  description:
    "Changes this site's autopilot: whether it runs, how many days of calendar it keeps filled (also the window to cancel an article), the keyword floor that triggers new keyword research, and the per-run ceilings; and backLinks (on by default, independent of autopilot): when an article is published, up to 3 older related articles get one link to it and are delivered again; and pushPage3 (on by default, independent of autopilot): once a week, up to 3 articles Google shows at positions 11 to 40 get a link from the site's best related pages and a tighter meta title and description around their main Search Console query (one model call each). Autopilot is on by default: it keeps the calendar filled, and each scheduled article is written and delivered to the site's connected destination on its day; enabled: false stops it. Fields left out stay as they are. Setting autopilot back on needs the spend and publish scopes, pushPage3 the spend scope; confirm is accepted and not needed.",
  input: z.object({ ...partialOf(AutomationSettings.shape), confirm: Confirm }),
  output: z.object({ settings: AutomationSettings }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const stored = await storedSettings(ctx);
    const settings = strictSettings(AutomationSettings, { ...stored.automation, ...changesOf(input) });
    // On by default: setting one back on is not asked again, only checked
    // against what the key may do.
    if (!stored.automation.enabled && settings.enabled) requireScopes(ctx, ["spend", "publish"], "Turning autopilot on");
    if (!stored.automation.pushPage3 && settings.pushPage3) requireScopes(ctx, ["spend"], "Turning Push page 3 on");
    const saved = await saveAutomationSettings({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, settings });
    if (!saved.ok) throw libRefusal(saved);
    return { settings: saved.settings };
  },
});

export const updateMediaSettings = defineTool({
  name: "update_media_settings",
  title: "Change images and video",
  description:
    "Changes this site's images and video: whether articles get an AI featured image, how many in-article images an article may also get (inlineImagesPerArticle, 0 to 3, 0 unless set; every image is generated for the article, included in the plan), their style (or custom art direction), brand colours, the image provider, and whether articles get YouTube videos. Images and videos are on by default; imagesEnabled: false or videosEnabled: false stops them for articles not yet written. Fields left out stay as they are. Setting images back on needs the spend scope; raising inlineImagesPerArticle on a site that has images on makes every article generated from then on get more generated images: it needs the spend scope and confirm: true.",
  input: z.object({ ...partialOf(MediaSettings.shape), confirm: Confirm }),
  output: z.object({ settings: MediaSettings }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const stored = await storedSettings(ctx);
    const settings = strictSettings(MediaSettings, { ...stored.media, ...changesOf(input) });
    // Images are on by default: setting them back on is only checked against
    // what the key may do. Allowing more per article than the site has is a
    // choice to spend more, and is asked for.
    const turningOn = !stored.media.imagesEnabled && settings.imagesEnabled;
    const raisingCap =
      settings.imagesEnabled && settings.inlineImagesPerArticle > stored.media.inlineImagesPerArticle;
    if (turningOn) requireScopes(ctx, ["spend"], "Turning images on");
    if (raisingCap) {
      requireScopes(ctx, ["spend"], "Allowing more images per article");
      requireConfirmation(
        input.confirm,
        `More images per article: every article this site generates from now on gets an AI featured image${
          settings.inlineImagesPerArticle > 0
            ? ` and up to ${settings.inlineImagesPerArticle} in-article image(s)`
            : ""
        }, each one generated for it and included in the plan: at most ${maxImagesPerArticle(settings)} image(s) per article.`,
        "Ask the person, then send the same call with confirm: true. imagesEnabled: false stops it for articles not yet written."
      );
    }
    const saved = await saveMediaSettings({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, settings });
    if (!saved.ok) throw libRefusal(saved);
    return { settings: saved.settings };
  },
});

export const WRITE_BUSINESS_TOOLS = [
  createBusiness,
  updateBusiness,
  analyzeWebsiteTool,
  updateAutomationSettings,
  updateMediaSettings,
] as const;
