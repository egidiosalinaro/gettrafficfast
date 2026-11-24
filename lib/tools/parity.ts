import type { ManualAction } from "@/lib/placements/workflow";

/**
 * GUI ↔ tool parity, as data (docs/API.md "Parity"). The owner's rule:
 * every action a person takes on a screen can be taken through the API and
 * MCP. Every route under `app/` that changes something (POST, PATCH, PUT,
 * DELETE) is listed here once, either with the tools that do the same
 * thing, or as an exception with the reason it is not a tool.
 *
 * `tests/tools/parity.test.ts` reads the routes from the file system: a
 * route that is in neither list fails it, and so does a mapped tool that
 * is not in the registry, or an entry whose route no longer exists. Adding
 * a screen action means adding its tool, or saying here why it has none.
 *
 * The key is `METHOD /path`, the path as the folder names it (`[id]` kept).
 */

export type MutatingMethod = "POST" | "PATCH" | "PUT" | "DELETE";

/** Why a route is not a tool. Each kind is a decision, written down once. */
export const PARITY_EXCEPTION_KINDS = {
  sign_in: "Signing in and OAuth: what gives an agent its credential cannot be a tool that needs one.",
  billing: "Stripe checkout and the billing portal: a payment or cancellation link must not pass through an AI chat.",
  api_keys: "API keys and connected apps: a key can never mint, list or revoke keys, or revoke a connection. Only the person, signed in.",
  spend_ceiling: "Owner-only: the AI spend ceiling. No key and no connection may raise it.",
  reviewer_account: "Owner-only: the directory reviewers' account creates a user and grants a plan. No key and no connection may do either.",
  credentials: "A WordPress application password or a webhook secret must not pass through an AI chat; a person connects them in Settings → Connections.",
  device: "About the device in hand, not the account's data: which site the browser shows. A key or a connection carries its site (the site picked on the consent screen, x-gtf-business, or a tool's site argument).",
  machine: "Called by machines, not by a screen: crons, the job worker, Stripe's webhook, the site's own blog receiver.",
  surface: "The API surfaces themselves: the REST runner and the MCP endpoint.",
} as const;
export type ParityExceptionKind = keyof typeof PARITY_EXCEPTION_KINDS;

export type ParityEntry =
  | { tools: readonly string[]; note?: string }
  | { except: ParityExceptionKind; note?: string };

const CRON = { except: "machine", note: "A Vercel cron, behind CRON_SECRET." } as const;

export const ROUTE_PARITY: Readonly<Record<string, ParityEntry>> = {
  // Today: Replies
  "POST /api/placements/[id]/action": {
    tools: [
      "mark_reply_posted",
      "unmark_reply_posted",
      "set_reply_link",
      "mark_reply_removed",
      "unmark_reply_removed",
      "dismiss_reply_target",
      "snooze_reply_target",
      "reopen_reply_target",
    ],
    note: "One route, one tool per action: MANUAL_ACTION_PARITY.",
  },
  "POST /api/placements/[id]/draft": { tools: ["draft_reply"] },
  "POST /api/placements/[id]/drafts": { tools: ["write_own_reply"] },
  "POST /api/placements/add": { tools: ["add_x_post"] },
  "POST /api/placements/discover": { tools: ["run_reply_discovery"] },
  "POST /api/placements/drafts/[id]/correct": { tools: ["correct_reply_draft"] },
  "PATCH /api/placements/drafts/[id]": { tools: ["edit_reply_draft"] },
  "POST /api/placements/feedback/[id]/promote": { tools: ["promote_feedback_to_notes"] },
  "POST /api/placements/match-links": {
    tools: ["paste_reply_links"],
    note: "The route matches and the page saves through the action route; the tool does both, through the same functions.",
  },

  // Content
  "POST /api/calendar/add": { tools: ["schedule_keywords"] },
  "POST /api/calendar/add-bulk": { tools: ["schedule_keywords"] },
  "POST /api/calendar/remove": { tools: ["unschedule_article"] },
  "POST /api/calendar/requeue": { tools: ["retry_article"] },
  "POST /api/calendar/dismiss": { tools: ["dismiss_today_articles"] },
  "POST /api/calendar/reschedule": { tools: ["reschedule_article"] },
  "POST /api/generate-now": { tools: ["generate_article"] },
  "POST /api/publish-now": { tools: ["publish_article"] },
  "POST /api/keywords/save": { tools: ["add_keywords"] },
  "DELETE /api/keywords/delete": { tools: ["delete_keywords"] },
  "POST /api/keywords/suggest": { tools: ["suggest_keywords"] },
  "PATCH /api/keywords/update": { tools: ["update_keyword"] },

  // Growth: AI answers, Google
  "POST /api/visibility/places": { tools: ["find_places_from_last_run"] },
  "POST /api/visibility/queries": { tools: ["add_prompts"] },
  "PATCH /api/visibility/queries": { tools: ["update_prompt"] },
  "DELETE /api/visibility/queries": { tools: ["delete_prompt"] },
  "POST /api/visibility/queries/import": { tools: ["import_prompts_from_keywords"] },
  "POST /api/visibility/queries/suggest": { tools: ["suggest_prompts"] },
  "POST /api/visibility/run": { tools: ["run_visibility_check"] },
  "POST /api/visibility/settings": { tools: ["update_visibility_settings"] },
  "POST /api/index-status/inspect": { tools: ["inspect_url"] },
  "POST /api/article-pushes": { tools: ["push_article"] },
  "POST /api/article-pushes/[id]": { tools: ["resolve_article_push"] },

  // Settings
  "POST /api/business/analyze": { tools: ["analyze_website"] },
  "POST /api/business/save": { tools: ["create_business", "update_business"] },
  "POST /api/business/automation-settings": { tools: ["update_automation_settings"] },
  "POST /api/business/media-settings": { tools: ["update_media_settings"] },
  "POST /api/business/voice-settings": { tools: ["update_voice_settings"] },
  "PATCH /api/business/voice-settings": { tools: ["update_voice_settings"] },
  "POST /api/business/voice-settings/about-you": { tools: ["add_about_you_fact"] },
  "DELETE /api/business/voice-settings/about-you": { tools: ["remove_about_you_fact"] },
  "PATCH /api/business/voice-settings/about-you": { tools: ["confirm_about_you_fact"] },
  "POST /api/integrations/disconnect": { tools: ["disconnect_integration"] },
  "POST /api/integrations/search-console/disconnect": { tools: ["disconnect_search_console"] },
  "POST /api/integrations/search-console/select-site": { tools: ["select_search_console_property"] },
  "POST /api/integrations/search-console/sync": { tools: ["sync_search_console"] },
  "POST /api/integrations/wordpress/connect": { except: "credentials" },
  "POST /api/integrations/webhook/connect": { except: "credentials" },
  "POST /api/business/select": { except: "device", note: "list_businesses lists the sites; whoami says which one the tools act on." },
  "POST /api/api-keys": { except: "api_keys" },
  "DELETE /api/api-keys/[id]": { except: "api_keys" },
  "DELETE /api/connected-apps/[id]": { except: "api_keys" },
  "PATCH /api/api-keys/[id]": {
    tools: ["set_default_site"],
    note: "A key's default site. The screen changes it for any of the person's keys; the tool for the key it is called with. Both call saveDefaultSite (lib/tools/site.ts).",
  },
  "PATCH /api/connected-apps/[id]": {
    tools: ["set_default_site"],
    note: "A connected app's default site. The screen changes it for any of the person's apps; the tool for the connection it is called with. Both call saveDefaultSite.",
  },
  "POST /api/create-checkout-session": { except: "billing", note: "get_subscription reads the plan." },
  "POST /api/create-billing-portal-session": { except: "billing" },
  "POST /api/owner/spend-limit": { except: "spend_ceiling", note: "get_platform_costs reads it, for an owner only." },
  "POST /api/owner/reviewer-account": { except: "reviewer_account" },
  "POST /api/auth/sign-in-method": { except: "sign_in", note: "Whether the sign-in form shows a password field (PASSWORD_LOGIN_EMAILS)." },
  "POST /api/auth/set-password": { except: "sign_in", note: "The reviewer account's password, from its set-password email." },

  // Public, machines and the surfaces themselves
  "POST /api/stripe-webhook": { except: "machine", note: "Stripe, signed." },
  "POST /api/gettrafficfast": { except: "machine", note: "This site's own blog receiver, signed." },
  "POST /api/jobs/tick": { except: "machine", note: "The job worker; its jobs are what the paid tools start." },
  "POST /api/cron/autopilot": CRON,
  "POST /api/cron/discover-placements": CRON,
  "POST /api/cron/generate-articles": CRON,
  "POST /api/cron/ingest-search-console": CRON,
  "POST /api/cron/inspect-index": CRON,
  "POST /api/cron/onboarding-emails": CRON,
  "POST /api/cron/probe-citations": CRON,
  "POST /api/cron/probe-visibility": CRON,
  "POST /api/cron/push-articles": CRON,
  "POST /api/cron/prune-tool-calls": CRON,
  "POST /api/cron/refresh-articles": CRON,
  "POST /api/cron/x-posts": CRON,
  "POST /api/cron/x-reply-links": CRON,
  "POST /api/v1/tools/[name]": { except: "surface" },
  "POST /api/mcp": { except: "surface" },
  "DELETE /api/mcp": { except: "surface", note: "Answers 405: the endpoint is stateless." },
  "POST /oauth/register": { except: "sign_in" },
  "POST /oauth/authorize/decision": { except: "sign_in", note: "The consent screen's Allow or Deny, same origin only." },
  "POST /oauth/token": { except: "sign_in" },
  "POST /oauth/revoke": { except: "sign_in" },
};

/**
 * The action route's moves, one by one: the route takes an `action`, and
 * each is its own tool. `approve` is kept for a tab open across a deploy;
 * no screen sends it and no step needs it (Reply on X does not ask for it).
 */
export const MANUAL_ACTION_PARITY: Readonly<Record<ManualAction, string | { except: "legacy"; note: string }>> = {
  mark_published: "mark_reply_posted",
  unmark_published: "unmark_reply_posted",
  set_published_url: "set_reply_link",
  mark_removed: "mark_reply_removed",
  unmark_removed: "unmark_reply_removed",
  dismiss: "dismiss_reply_target",
  snooze: "snooze_reply_target",
  reopen: "reopen_reply_target",
  approve: { except: "legacy", note: "No screen sends it: a reply is posted from its draft, with no approval step." },
};
