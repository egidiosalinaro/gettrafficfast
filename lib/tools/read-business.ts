import { z } from "zod";
import { AutomationSettings } from "@/lib/automation/settings";
import { businessProfile, loadBusiness } from "@/lib/business/read";
import { loadHomeSnapshot } from "@/lib/home-snapshot";
import { MediaSettings } from "@/lib/media/settings";
import { ONBOARDING_STEPS, nextOnboardingStep } from "@/lib/onboarding";
import { loadOnboardingStatus } from "@/lib/onboarding-status";
import { listFeedback } from "@/lib/placements/feedback";
import { listBusinesses } from "@/lib/tenancy";
import { loadVoiceSettings } from "@/lib/voice/read";
import { VOICE_PERSONS, VOICE_PRESETS, VoiceSettings } from "@/lib/voice/settings";
import { DEFAULT_SITE_SOURCES } from "@/lib/api-auth";
import { defaultSiteOf } from "./account";
import { defineTool, ToolError } from "./tool";

/**
 * The site and the account around it, as tools: which sites there are, one
 * site's settings, the Overview (operating loop and next action), the
 * Getting started checklist, Settings → Voice and the notes given on drafts.
 * Each handler calls the function the screen's route calls
 * (lib/business/read.ts, lib/home-snapshot.ts, lib/onboarding-status.ts,
 * lib/voice/read.ts, lib/placements/feedback.ts). All free.
 */

const Site = z.object({ id: z.string(), name: z.string().nullable(), websiteUrl: z.string().nullable() });

export const listBusinessesTool = defineTool({
  name: "list_businesses",
  title: "List sites",
  description:
    "The sites (businesses) this credential may act on, oldest first, and which one the other tools act on when a call names none (defaultId: the default saved with set_default_site, else the oldest). Name another with any site-scoped tool's site argument (its id, name or domain), or the x-gtf-business header; a key or a connection limited to one site lists only that one.",
  input: z.object({}),
  output: z.object({
    businesses: z.array(Site),
    selectedId: z.string().nullable().describe("The site this call acts on: the default, or the one the x-gtf-business header names; null when the account has none yet."),
    defaultId: z.string().nullable().describe("The site the other tools act on when a call names none; null when the account has none yet."),
    defaultSource: z
      .enum(DEFAULT_SITE_SOURCES)
      .describe("saved (set_default_site or Settings), oldest (none saved), only_site (limited to one site), selected (a browser session's site picker)."),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  async handler(ctx) {
    const { caller } = ctx;
    const owned = await listBusinesses(caller.client, caller.userId);
    const fallback = defaultSiteOf(caller);
    return {
      businesses: owned
        .filter((b) => caller.businessIds.includes(b.id))
        .map((b) => ({ id: b.id, name: b.name, websiteUrl: b.website_url })),
      selectedId: caller.businessId,
      defaultId: fallback.businessId,
      defaultSource: fallback.source,
    };
  },
});

export const getBusiness = defineTool({
  name: "get_business",
  title: "Get the site",
  description:
    "The site the tools act on, as Settings shows it: name, website, niche, description, sitemap and blog links, content language, whether the URL is locked, Autopilot (off by default: it writes and publishes on its own) and Images & video.",
  input: z.object({}),
  output: z.object({
    business: z.object({
      id: z.string(),
      name: z.string().nullable(),
      websiteUrl: z.string().nullable(),
      niche: z.string().nullable(),
      description: z.string().nullable(),
      sitemapUrl: z.string().nullable(),
      blogUrl: z.string().nullable(),
      contentLanguage: z.string().nullable(),
      isLocked: z.boolean().describe("Once saved the URL is frozen: the site's content was written for it."),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      automation: AutomationSettings,
      media: MediaSettings,
    }),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const read = await loadBusiness(ctx.client, ctx.userId, ctx.businessId);
    if (!read.ok) throw new Error(`business: ${String((read.error as { message?: string })?.message ?? read.error)}`);
    if (!read.business) throw new ToolError("not_found", "This site is no longer part of the account.", 404);
    return { business: businessProfile(read.business) };
  },
});

const StageView = z.object({
  id: z.string().describe("research, plan, produce, publish or measure."),
  status: z.string().describe("todo, active, pending or blocked: what the stage is doing, not a grade."),
  href: z.string().describe("The screen, as a path on the site."),
  title: z.string(),
  metric: z.string(),
  detail: z.string(),
});

export const getHome = defineTool({
  name: "get_home",
  title: "Get the operating loop",
  description:
    "The content operating loop stage by stage (research, plan, produce, publish, measure, with citation rates per engine, sampled), the replies waiting and posted this week, the one next action, the next articles on the calendar and the unused keywords. There is no Overview screen any more: when you point the person somewhere, use the screen the href names (Today, Growth, Content, Settings), never \"Overview\". For the day's work, get_today comes first.",
  input: z.object({}),
  output: z.object({
    business: z.object({ name: z.string().nullable(), websiteUrl: z.string().nullable(), niche: z.string().nullable() }),
    loop: z.object({
      stages: z.array(StageView),
      replies: z
        .object({
          status: z.string(),
          href: z.string(),
          title: z.string(),
          waiting: z.number().nullable().describe("Null when the inbox could not be read, not nothing waiting."),
          postedLast7Days: z.number().nullable(),
          metric: z.string(),
          detail: z.string(),
        })
        .optional(),
      nextAction: z
        .object({
          kind: z.enum(["onboarding", "attention"]),
          id: z.string(),
          title: z.string(),
          description: z.string(),
          href: z.string(),
          cta: z.string(),
        })
        .nullable(),
    }),
    upcoming: z.array(z.object({ id: z.string(), keyword: z.string(), scheduledDate: z.string(), status: z.string() })),
    unusedKeywords: z.array(
      z.object({
        id: z.string(),
        keyword: z.string(),
        searchVolume: z.number().nullable().describe("A model's estimate, not measured."),
        opportunity: z.string().nullable(),
      })
    ),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const home = await loadHomeSnapshot(ctx.client, ctx.businessId);
    if (!home.ok) throw new Error(`home: ${home.error}`);
    const { business, ...rest } = home.snapshot;
    return {
      business: { name: business.name, websiteUrl: business.website_url, niche: business.niche },
      ...rest,
    };
  },
});

const ONBOARDING_KEYS = ONBOARDING_STEPS.map((step) => step.key) as [
  (typeof ONBOARDING_STEPS)[number]["key"],
  ...(typeof ONBOARDING_STEPS)[number]["key"][],
];

const StepView = z.object({
  key: z.enum(ONBOARDING_KEYS),
  label: z.string(),
  description: z.string(),
  href: z.string(),
  done: z.boolean(),
});

export const getOnboardingStatus = defineTool({
  name: "get_onboarding_status",
  title: "Get the setup checklist",
  description:
    "The Getting started checklist for this site, step by step and in order: the business, About you, keywords, the first article, a connected website, the first post from X, Autopilot and article images (the last two start AI work on their own and stay off until switched on). next is the first step not done; complete when every step is.",
  input: z.object({}),
  output: z.object({
    steps: z.array(StepView),
    next: StepView.nullable(),
    complete: z.boolean(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const status = await loadOnboardingStatus(ctx.client, ctx.businessId);
    const steps = ONBOARDING_STEPS.map((step) => ({
      key: step.key,
      label: step.label,
      description: step.description,
      href: step.href,
      done: status[step.key],
    }));
    const next = nextOnboardingStep(status);
    return {
      steps,
      next: next ? (steps.find((step) => step.key === next.key) ?? null) : null,
      complete: next === null,
    };
  },
});

export const getVoiceSettings = defineTool({
  name: "get_voice_settings",
  title: "Get voice settings",
  description:
    "Settings → Voice: how the site sounds when the platform writes in its name. preset (tone), person (I, we, or whatever fits), aboutYou (the only facts a reply draft may state about the writer; drafting refuses while it is empty), articleFacts (Facts for articles: the only first-hand facts a public article may state; articles never read aboutYou, and with articleFacts empty they state no results or numbers of the writer's own) and instructions (the writer's own notes and rules). presets and persons list the choices. staleFacts lists the sentences of aboutYou whose date, or the day the person last confirmed them as still true (settings.confirmedFacts, written by confirm_about_you_fact), is more than staleAfterDays old: a draft states those as of their date, never as current, and nothing edits them but the owner.",
  input: z.object({}),
  output: z.object({
    settings: VoiceSettings,
    staleFacts: z
      .array(
        z.object({
          sentence: z.string().describe("The sentence of aboutYou, as written."),
          date: z.string().describe("The first day its most recent date names, YYYY-MM-DD (UTC)."),
          dateLabel: z.string().describe('As Settings prints it: "October 2026", "Oct 26, 2026".'),
          precision: z.enum(["day", "week", "part", "month"]),
          yearAssumed: z.boolean().describe("True when the text gave no year and the most recent past occurrence was taken."),
          confirmedOn: z
            .string()
            .nullable()
            .describe("The day (YYYY-MM-DD) the person last confirmed it as still true (confirm_about_you_fact), over staleAfterDays ago; null when never."),
          ageDays: z.number().int().describe("Days since the later of date and confirmedOn."),
          age: z.string().describe('"15 days ago", "last month".'),
          line: z.string().describe("The line Settings shows under About you."),
        })
      )
      .describe("Dated sentences of aboutYou older than staleAfterDays. Empty when none is dated or none is old."),
    staleAfterDays: z.number().int(),
    presets: z.array(z.object({ value: z.string(), label: z.string(), description: z.string() })),
    persons: z.array(z.object({ value: z.string(), label: z.string(), description: z.string() })),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const voice = await loadVoiceSettings(ctx.client, ctx.userId, ctx.businessId);
    if (!voice.hasBusiness) throw new ToolError("not_found", "This site is no longer part of the account.", 404);
    return {
      settings: voice.settings,
      staleFacts: voice.staleFacts,
      staleAfterDays: voice.staleAfterDays,
      presets: VOICE_PRESETS.map(({ value, label, description }) => ({ value, label, description })),
      persons: VOICE_PERSONS.map(({ value, label, description }) => ({ value, label, description })),
    };
  },
});

export const listDraftFeedback = defineTool({
  name: "list_draft_feedback",
  title: "List draft notes",
  description:
    "The notes the owner gave on this site's reply drafts (\"too long\", \"sounds like AI\"), newest first: each with the draft before and after its rewrite (bodyAfter null when it was not rewritten) and whether it was added to Settings → Voice notes.",
  input: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
  output: z.object({
    feedback: z.array(
      z.object({
        id: z.string(),
        targetId: z.string(),
        placementId: z.string().nullable(),
        reason: z.string(),
        bodyBefore: z.string().nullable(),
        bodyAfter: z.string().nullable().describe("The rewrite that was saved; null when none was."),
        promotedToNotes: z.boolean(),
        createdAt: z.string(),
      })
    ),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const listed = await listFeedback(ctx.client, ctx.businessId, { limit: input.limit });
    if (!listed.ok) throw new Error(`draft feedback: ${listed.error}`);
    return { feedback: listed.feedback };
  },
});

export const BUSINESS_READ_TOOLS = [
  listBusinessesTool,
  getBusiness,
  getHome,
  getOnboardingStatus,
  getVoiceSettings,
  listDraftFeedback,
] as const;
