# GetTrafficFast — target architecture

The product is not an article generator. It is a **content operating system**:
a customer connects a site, and the platform researches, plans, writes,
enriches, publishes, monitors and continuously improves the content that makes
that business findable — on search engines (SEO) and inside AI answer engines
(AEO).

An article is an output of the strategy, never the starting point.

A sign-in lands on **Today** (`/today`, `APP_HOME` in `lib/app-home.ts`,
since 2026-11-14): the first screen of the day, Overview and Replies in one.
The pricing pages and the home-screen app (`app/manifest.ts`, start URL)
land there too, and an explicit `?next=` path on this site still wins.
`/placements` and `/dashboard` redirect there with their query string. From
the top: "3 of 5 replies" toward the daily goal and where today's links
stand; three tabs, To do, Posted and Archive (`TODAY_VIEWS`,
`lib/placements/inbox-view.ts`), in place of eleven lists; the open reply;
"Also today", the other gestures of the day (an article a gate held or that
failed, a fact of About you to re-confirm, a reply whose link GTF stopped
looking for), each with the action it already had (a held or failed
article can also be ignored there, and stays in Content); then the next replies.
One read, `lib/today/read.ts`, answers `GET /api/today` and `get_today`
(docs/PLACEMENTS.md, "Today"). The Overview's stages are still
`lib/domain/operating-loop.ts`, read by `get_home`; its screen is gone, and
the one thing on it that asked for a person, a held or failed article, is
under Also today. **Content** (`/content`, since 2026-11-14) is
where the articles are: the Autopilot state, today's article in words (why
it waits, when it does), the week Monday to Sunday and the next topics with
where each came from, read from `lib/calendar/content.ts` (`get_content`).
Behind it, All articles (`/content/articles`) is the production board, one
board in that loop, not the product, and All topics (`/content/topics`) is
the keyword pool with its estimates, "Overlapping topics" and "Questions
people ask"; `/dashboard/calendar`, `/keywords` and `/dashboard/keywords`
redirect there with their query string (`lib/content-paths.ts`). What each
stage says, and which next action is offered, lives in
`lib/domain/operating-loop.ts` so the screen cannot invent a 0% citation
rate when nothing has been probed. After a failed or held article, which
needs a person first, the next action is the first unfinished step of the Getting started checklist
(`lib/onboarding.ts`, shared with the corner widget; under it the widget suggests "Connect Claude", marked optional: it never counts toward done nor keeps the checklist open, and `GET /api/onboarding/status` adds `hasClaude`, true with a live API key or a live claude.ai grant): the business, then
About you (Settings → Voice; replies speak only from it), keywords, the first
scheduled article, the connected site, the first post added from X
(a `placement_targets` row with `found_via` `manual`), Autopilot, and article
images. The corner widget starts collapsed to a pill on every device; while
the pill shows it sets `data-getting-started-pill` on `<html>`, and a phone's
content keeps 3.5rem at the bottom instead of 1rem (`pb-mobile-chrome`,
`app/globals.css`) so the pill never covers a button.

On a phone the page itself does not scroll (since 2026-11-10): the shell is
one screen tall, `AppScroll` (`components/dashboard/app-scroll.tsx`) scrolls
the section, and the tab bar is the shell's last row, in the flow. It was
`position: fixed`, and on an iPhone, as a home-screen app, iOS left it in the
middle of the screen after a change of scroll direction. From `md` up
`AppScroll` is `display: contents` and the page scrolls as before. The first
row of the scrolling area is the site switcher (`MobileSiteBar` in
`components/dashboard/mobile-nav.tsx`: the site's name and a chevron, phones
only), so it scrolls away with the page and costs no height while reading.

The signed-in app is four sections (since 2026-11-14; there were nine
entries and a phone "More" sheet). One definition, `components/dashboard/nav.ts`,
draws the desktop sidebar and the phone's tab bar, and each section has the
name of its page heading:

| Section | Route | Replaced |
|---|---|---|
| **Today** | `/today` | Overview and Replies (`/dashboard`, `/placements`) |
| **Growth** | `/growth`, `/growth/ai` | Results and Prompts (`/results`, `/visibility`) |
| **Content** | `/content`, `/content/articles`, `/content/topics` | Articles and Keywords (`/dashboard/calendar`, `/keywords`) |
| **Settings** | `/settings` | it took the account menu (sign out is in Account) and Help |

Help and Contact Us became the public docs at `/docs`. A section is lit on
its own pages (`/growth/ai` is Growth). The old paths redirect, so the nav
keeps nothing for them, and in-app links name the new paths. The desktop
sidebar is the brand, the site switcher, the four sections, then "Docs and
help" and the account (photo or initials, and the address), a link to
Settings → Account.
The phone has the four tabs and nothing else: the docs and the account are
rows of Settings. The tab bar carries no count of replies to do: the shell
has no source for it that does not cost a request per navigation.

The signed-in sections share one layout, `app/(app)/layout.tsx`. The shell
owns the site switcher and passes the account's sites in from the server, so
a menu click does not remount it.
`requireAppAccess` is wrapped in React `cache()`, so the shell, the section
layout and a page share one auth and subscription check per request, and
`app/(app)/loading.tsx` (one `SectionSkeleton`) paints the moment a menu item
is tapped.

**Settings** (regrouped 2026-11-14, phase 2 of the UX simplification) is
three groups, listed once in `components/dashboard/settings-nav.ts` and read
by the phone's `/settings` page, the desktop column (`SettingsSubmenu`) and
every page's back link (`SettingsBackLink`, `settingsBack`): **This site**
(Business `/settings/business`; Voice and facts `/settings/voice`;
Connections `/settings/integrations`, which is Search Console, Find posts on
X and the blog destinations; Claude and API `/settings/api-keys`, how to
connect Claude through MCP and the API keys; Autopilot
`/settings/automation`, with Images and video folded in under `#images`),
**Plan** (Billing `/settings/billing`) and **You** (Account
`/settings/account`, with sign out, and Docs and help, the public `/docs` in a
new tab). On a phone `/settings` is that list (rows with a line saying what is
inside) and each page has "‹ Settings" at the top; a page under another
("‹ Connections" on WordPress) has its back link on every screen. The paths
are the old ones, because Google's consent screen, the Stripe portal and the
onboarding emails return to them; the one page that moved,
`/settings/generation`, redirects with its query string
(`lib/legacy-redirects.ts`, served by `redirects()` in `next.config.ts`).

**Docs** (`/docs`, public, crawlable, in the sitemap) replaced the in-app
Help and Contact the same day: getting started, Today, Content, Growth and
how each number is measured (`#how-we-measure`), using GTF from Claude
(`#claude`), the tools, the API and its limits (`#limits`), and the contact
inbox (`#contact`). The tool list is `TOOLS.list()` and the limits are
`TOOL_LIMITS` and the daily caps, read at request time, so the page cannot
drift from the registry (`components/docs/`). `/help`, `/dashboard/help` and
`/dashboard/contact` redirect there.

This document is the reference every architectural decision is checked against.
It describes the target, how today's code maps onto it, and the order in which
to get there. The operating rules for working in this repository — identity,
tenancy, honest measurements, paid calls — are in `AGENTS.md`.

---

## 1. The decision that makes the rest work

Two requirements are in tension:

- the platform must be **agentic** — specialised agents, composable, swappable;
- content production must be **deterministic** — reproducible, testable, and
  incapable of shipping a corrupted document.

The resolution: **the orchestration is code, the steps are agents.**

The graph of what runs, in what order, with what inputs and what happens on
failure, lives in normal TypeScript with tests. Each node calls an agent whose
inference is model-driven but whose input and output are schema-validated
structures. Nothing decides "what to do next" by prompting a model.

This is the same lesson as the content pipeline refactor: the failure mode
wasn't the model, it was trusting unstructured output. An agent that returns a
validated structure is a component; an agent that returns prose the next step
has to interpret is a liability.

External agents (Claude, ChatGPT, Codex) orchestrate the platform **through the
Tool layer over MCP** — they drive it from outside, they don't live inside it.

---

## 2. Layers

Every layer depends only on the ones below it. No layer reaches sideways.

```
  UI  (app/, components/)
   │
  Tools            capability surface — internal callers + MCP           lib/tools/
   │
  Application      use cases: orchestration graphs, transactions         lib/application/
   │
  Agents           one responsibility each, structured I/O               lib/agents/
   │
  Domain           entities, lifecycle, invariants — no I/O              lib/domain/
   │
  ├── Pipeline     LLM output → Canonical Article (exists)               lib/content/
  ├── Knowledge    entities, topics, clusters, links                     lib/knowledge/
  ├── Media        image/video assets                                    lib/media/
  ├── Analytics    metrics, rankings, AI citations                       lib/analytics/
  ├── Publishers   destination adapters (exists)                         lib/publishing/
  └── Storage      repositories over Supabase                            lib/storage/
   │
  Providers        every external system behind an interface             lib/providers/
                   llm · images · video · serp · analytics · citations
```

### Where today's code sits

| Layer | Today | Action |
| --- | --- | --- |
| Pipeline | `lib/content/` — stages, gates, canonical model | keep; becomes the *Validation* stage of the larger flow and is reused for **every** LLM artifact, not just articles |
| Publishers | `lib/publishing/` — adapter interface + registry | keep as-is; already the target shape |
| Application | `lib/jobs/workflows/` (production), `lib/content/service.ts` (publishing) | **done** for article production; further use cases land in `lib/jobs/workflows/` |
| Providers | `lib/providers/` — llm, images (Google/OpenAI), video (YouTube), serp (Serper) | **done** for LLM, images, video and SERP. Analytics still to build |
| Domain | `lib/domain/lifecycle.ts` | **done** for the states in use; extend as later phases produce new ones |
| Agents | `lib/agents/` — contract, runner, outline, writing, AEO audit | **done** for the first slice; the rest of the roster follows |
| Media | `lib/media/` — settings, prompt composition, storage, tree-based embedding | **done** for Phase 2 |
| Knowledge | `lib/knowledge/` — graph repository, verified linking | **done** for Phase 3 |
| Lifecycle | `lib/lifecycle/` — rank, decay, refresh guard | **done** for Phase 5's first slice |
| Analytics | `lib/analytics/` + `lib/providers/analytics/` — Search Console ingestion | **done** for Phase 5's third slice |
| Visibility | `lib/visibility/` — query set, verdict, run summary (pure) + store | **done** for Phase 5's fourth slice |
| Placements | `lib/placements/` — rules, qualification, audit gate, lifecycle | **done** through the review queue |
| Tools | `lib/tools/` — registry, runner, REST (`/api/v1/tools`) and MCP (`/api/mcp`); API keys | **started**: Replies is on it, the other domains follow (`docs/API.md`) |

`lib/gemini/` is gone: `lib/providers/llm/` is the only place that names a
model vendor (`gemini.ts`, `anthropic.ts`, chosen in `registry.ts`). Keyword
research and business analysis moved to `lib/research/` and go through the same
provider.

---

## 3. The agent contract

One interface. Every agent is replaceable, individually testable, and observable
without touching its callers.

```ts
export interface AgentContext {
  businessId: string;
  articleId?: string;
  language: string;
  /** Correlation id shared by every agent in one production run. */
  runId: string;
  /** Hard ceiling: agents must not silently spend beyond it. */
  budget: { maxTokens: number; maxCostUsd: number };
  signal?: AbortSignal;
}

export interface AgentResult<O> {
  output: O;
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
  /** Non-fatal observations, aggregated by the orchestrator. */
  notes: string[];
}

export interface Agent<I, O> {
  readonly name: string;          // "outline", "aeo-optimizer", …
  readonly version: number;       // bumped on prompt/schema change
  readonly inputSchema: Schema<I>;
  readonly outputSchema: Schema<O>;
  run(input: I, ctx: AgentContext): Promise<AgentResult<O>>;
}
```

Rules:

- **Structured output or nothing.** Output is validated against `outputSchema`
  before it leaves the agent; a violation is a failed run, not a "best effort".
- **An agent never writes to the database.** It receives data and returns data.
  Persistence belongs to the application layer.
- **Every run is recorded** in `agent_runs` (input, output, model, tokens, cost,
  latency, status). This is the checkpoint log *and* the audit trail *and* the
  cost report — the same principle already applied to the content pipeline.
- **Versioned prompts.** `version` changes when behaviour changes, so a
  regression can be attributed to a specific agent revision.

### The agent roster

Grouped by what they need, which is also the order in which they become
buildable:

| Group | Agents | Depends on |
| --- | --- | --- |
| **Strategy** | Research, Search Intent, Keyword Strategy, Content Planner | business profile; SERP provider for the stronger versions |
| **Competitive** | SERP Analysis, Competitor | a SERP data provider (external, paid) |
| **Production** | Outline, Writing, FAQ | strategy outputs |
| **Optimisation** | SEO Optimizer, AEO Optimizer, Schema.org, Internal Linking | knowledge graph for linking |
| **Enrichment** | Image, Video | media providers |
| **Lifecycle** | Content Refresh, Analytics | analytics providers + history |

Publishing is deliberately **not** an agent: it has no inference. It is an
application use case over the publisher adapters that already exist.

### Cadence: not everything is per-article

The production flow reads as one pipeline, but its stages do not run at the same
rhythm, and treating them as if they did would multiply cost and latency for a
result that barely changes between articles.

- **Per business, periodically** (weekly, or on demand): Research, SERP
  Analysis, Competitor, Search Intent, Keyword Strategy, Content Planner. Their
  output is a standing editorial plan.
- **Per article**: Outline, Writing, SEO/AEO, Media, Validation, Publishing —
  reading the plan rather than recomputing it.
- **Continuous**: Analytics, Content Refresh, driven by measurement.

---

## 4. The Tool layer and MCP

A tool is the platform's public verb. It holds no rule of its own: its
handler calls the application function the screen's route calls, so the
screen and the tool cannot drift.

```ts
// lib/tools/tool.ts (built, November 2026)
defineTool({
  name: "draft_reply",                 // snake_case, verb first
  title: "Draft a reply",
  description: "…",                    // what an external agent reads
  input: z.object({ … }),              // validated before the handler runs
  output: z.object({ … }),             // validated after
  scope: "read" | "write" | "publish", // what the key must allow
  paid: true,                          // costs money: needs `spend` and a subscription
  owns: { targetId: "placement_targets" }, // ids the runner checks against the caller's site
  handler(ctx, input) { … },           // ctx: user, site, the caller's client
});
```

One registry (`lib/tools/registry.ts`) is consumed by three surfaces:

1. the internal orchestrator (application layer calls tools, not agents
   directly). Not yet: workflows still call agents.
2. the HTTP API, `POST /api/v1/tools/:name` with `GET /api/v1/tools` as the
   catalogue. Built.
3. an **MCP server** (`/api/mcp`), so Claude/ChatGPT/Codex can drive the
   platform. Built: stateless Streamable HTTP over the same runner.

Because all of them share one registry, one runner (`lib/tools/runner.ts`) and
one schema, a capability cannot exist in the UI and be missing over MCP, or
behave differently across them. The runner is also where tenancy for API
callers is enforced: a session keeps its RLS client; an API key
(`Authorization: Bearer gtf_…`, `lib/api-keys.ts`) gets the service role
narrowed to its owner (`lib/supabase/owner-scoped.ts`), and every id an input
names is checked against the caller's user and site before the handler runs.
Why that and not a minted user JWT, the scopes (`read`, `write`, `spend`,
`publish`), the error shape and the tool catalogue: `docs/API.md`.

A custom connector on claude.ai cannot send a header, so the MCP endpoint
also takes an OAuth access token (`Authorization: Bearer gtfat_…`). The app
is its own authorization server for that one resource (`lib/oauth/`, no new
vendor): RFC 9728 and RFC 8414 metadata under `/.well-known/`, dynamic client
registration, a consent screen behind the Supabase session
(`/oauth/authorize`), the code flow with PKCE S256 and the `resource`
parameter, rotating refresh tokens with reuse detection, revocation, and
Settings → Claude and API → Connected apps. `resolveCaller` turns a token into the
same caller a key is (the grant's owner, its site, its scopes, the
owner-scoped service role), so the runner and everything under it is
unchanged. The flow, the storage and the security choices: `docs/API.md`,
"Connect from claude.ai".

Scopes are what make external orchestration safe: anything that costs money
needs `spend`, which a key does not have unless the person ticked it; anything
that would act in the owner's name in public needs `publish`: `publish_article`
(onto the site's own connected destination, with `confirm: true`) and turning
autopilot on. Nothing posts on X or Reddit: a tool hands a person the link to
post. A call that would switch spending on (a visibility run or cadence,
autopilot, images) also answers `confirmation_required`, with what it would
cost, until it is sent with `confirm: true`. The runner also holds each key,
and each app connected over OAuth, to a burst limit and per-tool daily caps,
and records every call in `tool_calls` (`docs/API.md`, "Limits and the audit
log"). The consent screen asks for scopes as a new key does: Read and Write
ticked, Spend and Publish only when the person ticks them.

The first domain on it is **Replies** (Today, `/today`; `/placements` until 2026-11-14): every inbox action is a
tool (`lib/tools/replies.ts`). The writes of the other screens followed
(keywords, calendar, AI Visibility, the site's settings, voice, integrations:
`lib/tools/write-*.ts`), and so did every read they make (articles, keywords,
visibility, results, the site, integrations, billing: `lib/tools/read-*.ts`)
and the calendar's Generate now and Publish (`lib/tools/articles-produce.ts`),
each over the function its route calls.

Two rules keep that true as screens change (2026-11-14). Every route that
changes something is listed in `lib/tools/parity.ts` with the tools that do
the same, or as an exception of a decided kind (keys, billing, credentials,
the spend ceiling, sign-in, machines), and a test reads the routes from the
file system, so a screen action without a tool fails the build. And the
routine itself is on MCP as prompts (`daily_routine`, `weekly_review`,
`lib/tools/prompts.ts`): text templates that tell Claude which tools to call
under the screens' rules, calling none themselves (`docs/API.md`, "Prompts").

One exception to "one registry everyone sees": the platform owner's tools
(`get_platform_costs`, `lib/tools/owner.ts`) are kept out of `TOOLS`, so the
public catalogue, the docs and a customer's `tools/list` never name them.
`registryFor(userId)` adds them for an owner (`PLATFORM_OWNER_USER_IDS`,
`lib/owner.ts`, fail closed); for anyone else they are the 404 a made-up
name gets. They read; nothing on the API sets a spend ceiling.

Target surface (their names are the product's vocabulary): `research_keywords`,
`analyze_serp`, `analyze_competitors`, `plan_content`, `generate_outline`,
`write_article`, `generate_faq`, `generate_images`, `find_videos`,
`generate_schema`, `optimize_seo`, `optimize_aeo`, `generate_internal_links`,
`improve_article`, `refresh_article`, `publish`, `republish`,
`analyze_performance`, `check_ai_citations`.

---

## 5. Providers: nothing vendor-specific above this line

Each external system sits behind an interface with a registry and per-business
configuration. Adding a vendor is one file; switching vendors is one setting.

| Provider | Interface | First implementation | Later |
| --- | --- | --- | --- |
| LLM | `generate<T>(prompt, schema, opts)` | Gemini; Claude (`lib/providers/llm/anthropic.ts`) as the opt-in fallback, `LLM_FALLBACK=anthropic`; the article writer can have its own primary, `LLM_WRITER_PROVIDER`; the article agents can alternate between providers by day, `LLM_ARTICLE_ROTATION` | OpenAI, routing for more roles |
| Images | `generate(prompt, aspect, quality)` | Google `gemini-*-image` (`lib/providers/images/google.ts`) | OpenAI (done), Ideogram, Flux, Fal |
| Video | `search(query, intent)` | YouTube Data API | Vimeo, TikTok, Loom |
| SERP | `search(keyword, language)` | Serper.dev (`SERPER_API_KEY`, optional) | multiple, with fallback |
| Analytics | `metrics(site, range)` | Google Search Console (`lib/providers/analytics/`) | GA4, Bing |
| Citations | `probe(query)` | Perplexity (`lib/providers/citations/`) | search-grounded Gemini/OpenAI, Bing Copilot |

Per-agent model routing matters economically: a cheap fast model for
classification and extraction, a stronger one for writing. That decision belongs
to configuration, not to the agent.

---

## 6. Domain: the content lifecycle

Today `articles.status` is a workflow flag. It becomes an explicit state machine
in `lib/domain/lifecycle.ts`, with allowed transitions enforced in one place.

```
draft ─▶ researching ─▶ outlined ─▶ generated ─▶ validated ─▶ enriched
                                         │                        │
                                         ▼                        ▼
                                   needs_review ◀────────────  published
                                                                   │
                                              indexed ─▶ monitored ─┤
                                                    │              │
                                        needs_refresh ◀────────────┘
                                                    │
                                             republished ─▶ archived
```

Design notes:

- `needs_review` and `failed` are reachable from every production state; they are
  not steps, they are outcomes. This preserves what the quality gates already do.
- **Every state transition is persisted with its cause** (`article_events`), so
  "why is this article stuck" is answerable without reading logs.
- `article_versions` keeps each published canonical document. Refresh compares
  against the last version and produces a diff instead of regenerating from
  scratch — that is what makes continuous improvement affordable.

---

## 7. Knowledge layer

The graph is what turns a pile of articles into topical authority. It must be
built from day one of the data model, even while the agents that exploit it are
still missing — retrofitting entities onto hundreds of published articles is far
more expensive than recording them at write time.

```sql
entities          (id, business_id, type, name, canonical_name, external_ids jsonb)
article_entities  (article_id, entity_id, role, salience)      -- what an article is about
topics            (id, business_id, name, parent_id, pillar_article_id)
article_topics    (article_id, topic_id, is_primary)           -- clusters
article_links     (from_article_id, to_article_id, anchor, status)
competitors       (id, business_id, domain, name)
serp_snapshots    (id, keyword_id, captured_at, results jsonb) -- SERP over time
article_versions  (id, article_id, version, canonical jsonb, reason, created_at)
article_events    (id, article_id, from_state, to_state, cause, actor, created_at)
agent_runs        (id, business_id, article_id, agent, version, input jsonb,
                   output jsonb, model, tokens, cost_usd, latency_ms, status)
media_assets      (id, business_id, article_id, kind, provider, prompt,
                   url, storage_path, meta jsonb)
content_metrics   (article_id, date, source, impressions, clicks, position)
ai_citations      (id, business_id, article_id, engine, query, cited,
                   snippet, checked_at)
```

What the graph unlocks, in order of payoff:

1. **Internal linking** that is real: link when two articles share an entity or a
   cluster, with the anchor chosen from the target's own headings.
2. **Gap analysis**: entities the competitors cover and we don't.
3. **Cluster planning**: pillar + supporting articles instead of a flat list.
4. **Cannibalisation detection**: two articles competing for one intent.

---

## 8. SEO and AEO

SEO is well understood. AEO — being *cited* by ChatGPT, Claude, Gemini,
Perplexity — comes down to one thing: **an answer engine retrieves a passage,
not a page.** Everything follows from that.

Concrete, implementable properties, each enforceable by an agent and checkable by
a gate:

- **Answer-first sections.** Every `<h2>` answers its own question in the first
  two or three sentences, before context or narrative.
- **Question-shaped headings**, matching how people actually ask.
- **Self-contained chunks.** No "as we saw above", no antecedents that only
  resolve earlier in the page. A section lifted out of context must still make
  sense — this is the single highest-leverage AEO property.
- **Explicit entities and definitions** — name the thing, define it once,
  plainly.
- **Structured data**: `Article`, `FAQPage`, `Organization`, `BreadcrumbList`
  JSON-LD, consistent with the visible content.
- **Factual density with real sources.** Verifiable claims, linked to
  authoritative URLs that actually exist (the writing prompt already forbids
  inventing links; the AEO agent should *add* verified ones).
- **E-E-A-T signals**: named author entity, published and updated dates,
  citations, organisation identity.
- **Retrieval-friendly formatting**: short paragraphs, lists for steps, tables
  for comparisons, stable heading anchors (already implemented).

These become checks in the existing gate framework, so an article that is
structurally unciteable is caught before publication exactly like a corrupted one
is today.

**Honest limit on measurement.** No engine offers "was I cited" as an API. The
implementable approximation is *citation probing*: run the target queries against
engines that expose sources (Perplexity, search-grounded models), record whether
the domain appears, and track the rate over time. It is a sampled metric, not
ground truth, and it should be presented to customers as such.

---

## 9. Media

Images are part of article generation, not a post-processing step: the Outline
agent declares *where* an image belongs and *what it must show*; the Image agent
renders those slots.

Per-business settings, all provider-agnostic: provider, style (photographic /
illustration / diagram), aspect ratio, count, quality, realism, brand palette,
hero vs in-article. Assets are generated once, stored in Supabase Storage (never
hot-linked from a provider CDN that expires), recorded in `media_assets`, and
referenced by the canonical document.

This forces one addition to the Canonical Article: media slots as first-class
fields, so every publisher adapter can map them to its own destination (WordPress
featured image, `body_html` figures, webhook payload fields).

Video is a retrieval problem, not a generation one: the Video agent searches
(YouTube first) and embeds **only** when the video genuinely serves the section's
intent. An irrelevant embed hurts both SEO and the reader, so this needs a
relevance threshold and a gate, not a "always add a video" rule.

---

## 10. Execution model — the constraint that shapes everything

This is the part the vision implies but doesn't state, and it cannot be deferred.

Today one article is one LLM call inside one serverless invocation. The target
pipeline is **eight to fifteen** agent calls plus external APIs per article.
That will not fit in a single function invocation: it exceeds serverless time
limits, and a failure at step 12 must not discard steps 1–11.

So the platform needs **durable, resumable execution**:

- a job per article production run, with **step-level checkpointing** —
  `agent_runs` is already the checkpoint log;
- resume from the last completed step, never from the start;
- per-step retry with backoff, and per-run budget ceilings;
- fan-out where steps are independent (SERP, competitors and intent can run in
  parallel; outline waits for all three).

Options: a queue on Postgres (`pg_cron` + a claim table, no new vendor), or a
durable workflow service (Inngest, Trigger.dev, QStash). The cron becomes a
scheduler that *enqueues* work rather than performing it.

Until this exists, adding agents makes the system less reliable, not more
capable. **It is the first thing to build.**

---

## 11. Economics

Worth stating plainly, because it constrains design:

- today: ~1 model call per article;
- target: ~10 calls plus SERP, image and video API costs.

With a cheap model for extraction/classification and a strong one only for
writing and optimisation, per-article cost stays small — but SERP data and image
generation are *real* per-unit costs that scale with customers, and they must be
attributable per business (`agent_runs.cost_usd`, `media_assets`) before they
are enabled, not after. Model routing per agent is a cost lever, and it belongs
in configuration.

**Who sees the cost (2026-11-14).** The customer pays a fixed subscription and
never sees a model or provider cost in dollars: Settings → Billing shows his
plan's quotas in his own units (`lib/limits/quotas.ts`), and the daily AI
spend ceiling that protects the platform reads, when reached, only as
"today's limit for AI work" and when it resets. The costs are the owner's:
`/settings/costs` and `get_platform_costs` read `provider_spend` (the X API
against `X_API_MONTHLY_CAP_USD`) and each account's
`agent_runs` against its ceiling, which only an owner sets (docs/API.md "The
owner's costs").

**Owner-only down to the column.** Hiding the costs on the screens is not
enough: a customer can query PostgREST with his own session (role
`authenticated`), and RLS returns his own rows. So the role cannot select
them at all: `agent_runs.cost_usd` and `llm_calls`, `aeo_runs.cost_usd`,
`aeo_probes.cost_usd`, `tool_calls.cost_usd` and `media_assets.meta` are
revoked, every other column granted by name, and the RPC that summed
`tool_calls.cost_usd` is the service role's only (migration
`20261114160000_hide_costs_from_customers.sql`). Session reads of those
tables name their columns; anything that needs a cost, the spend ceiling
included, reads it through the service role after the ownership check.

---

## 12. Sequencing

Each phase is independently valuable and leaves the system coherent.

**Phase 0 — Foundations.** ✅ *Done.* Durable job runner with step checkpointing
(`lib/jobs/`); `LLMProvider` interface with Gemini behind it
(`lib/providers/llm/`); agent contract + runner + `agent_runs` (`lib/agents/`);
lifecycle state machine + `article_events` (`lib/domain/lifecycle.ts`).
See `docs/AGENT_RUNTIME.md`.

**Phase 1 — First vertical slice.** ✅ *Done.* Article production is the
`produce-article` workflow: Outline → Writing → Validation (the existing content
pipeline and gates) → SEO/AEO audit, executed by the job runner. The cron and
"Generate now" both enqueue it; neither generates inline any more.

**Phase 2 — Media.** ✅ *Done.* Provider-agnostic image layer (Google's
`gemini-*-image` models via the existing key, OpenAI optional) and YouTube video retrieval; per-business
media settings in Settings → Autopilot → Images and video (`/settings/automation#images`; off by default — media costs money);
the image-brief agent decides WHAT each image shows, code composes the brand
style, providers render, assets land in the platform's own storage bucket and
`media_assets`; the video-select agent judges relevance with "none" as the
expected outcome. Canonical carries `media`; inline images are embedded as
`<figure>` at section ends, the hero maps to WordPress's featured image, videos
travel structurally (webhook payload v3) and as oEmbed URLs for WordPress.
See `docs/MEDIA.md`.

**Phase 3 — Knowledge.** ✅ *Done.* Graph tables (`entities`, `article_entities`,
`topics`, `article_topics`, `article_links`); the knowledge-extract agent names
what every generated article is about and the graph is written at production
time; the internal-links agent proposes anchors that the linking module verifies
character-for-character against a single text node before wrapping them in
`<a>` — a hallucinated anchor is dropped, never guessed. Links only target
articles that are live (`published_url` set), and every applied link is recorded
in `article_links`. See `docs/KNOWLEDGE.md`.
*Compounds: every article makes the next one better.*

**Phase 4 — Intelligence.** ✅ *Done (first slice).* SERP provider layer
(Serper.dev behind `lib/providers/serp/`, optional — production degrades
gracefully without it); a `research` step opens `produce-article`: the SERP is
fetched (snapshots reused for 7 days — SERPs move on the scale of weeks, every
fetch is paid), recorded verbatim in `serp_snapshots`, competitors are
discovered by code and upserted into `competitors`, and the serp-analysis
agent judges intent, real difficulty, angle, must-answer questions and gaps.
The outline plans against that evidence — differentiating from the titles that
actually rank — instead of the model's priors. See `docs/INTELLIGENCE.md`.
Remaining for later slices: SERP-informed keyword suggestion scoring, gap
analysis against the competitor/entity graph.

**Phase 5 — Lifecycle.** ✅ *Done (first slice).* Rank measurement from the
SERP snapshots Phase 4 already records (`content_metrics`, source-tagged so
Search Console lands in the same table later); conservative decay detection
(cooldown, lost ranking, real slips, staleness); a `refresh-article` workflow
that plans, rewrites, and replaces the live document only when it passes the
same gates as a new article AND keeps its substance (`assessRefresh`);
`article_versions` archives every superseded document; adapters update the
existing post instead of duplicating it. Weekly sweep at
`/api/cron/refresh-articles`. See `docs/LIFECYCLE.md`.
Citation probing landed as the second slice: `ai_citations`, a citations
provider layer (Perplexity first, the registry returns every configured
engine) and a weekly sweep at `/api/cron/probe-citations` that records
whether an answer engine cited the customer — negatives included, because a
rate without them is meaningless. See `docs/CITATIONS.md`.
Search Console ingestion landed as the third slice: per-user OAuth against a
read-only `webmasters.readonly` grant, an `analytics_connections` table for the
encrypted refresh token, per-page attribution onto articles, a daily sweep
at `/api/cron/ingest-search-console`, and a first-connect `search-console-ingest`
job so Results never waits until 07:00 UTC. Real impressions and clicks now sit in
`content_metrics` beside the sampled rank. See `docs/ANALYTICS.md`.
AI Visibility landed as the fourth slice: the customer-facing, per-business
measurement. An explicit, clustered query set the owner configures, runs
that freeze the set and the engines they asked, one probe per question per
engine with status, sources, competitors, excerpt, latency and estimated
cost, and a dashboard that shows rates per engine only, coverage beside them,
and a trend only between comparable runs (`lib/visibility/`; on screen,
Growth → AI answers, `/growth/ai`). Same providers as the article
citation probes, and the shared matching primitives of
`lib/domain/source-matching.ts`; the run is a durable job, and the worker learned to hand
steps a deadline and to resume a step that yields (`StepIncomplete`). See
`docs/AI_VISIBILITY.md`.
Remaining for later slices: query-level Search Console data feeding keyword
strategy, and the results surface growing beyond its first table.
*This is what turns the product from "generates content" into "keeps content
competitive" — the actual differentiator.*

**Phase 5b — Autopilot.** ✅ *Done.* Publishing used to stop whenever the
customer stopped scheduling by hand: keywords only reached the calendar
manually, so six keywords meant six days and then silence. A daily sweep now
keeps the calendar filled `bufferDays` ahead and tops up the keyword pool below
a floor, both threshold-driven so cost tracks the buffer rather than the time
the customer has been away, and off by default because it spends money and
publishes on their site. See `docs/AUTOPILOT.md`.

**Phase 6 — MCP.** 🔨 *Started (November 2026).* Expose the tool registry. It
was deliberately late: exposing a capability surface that is still moving
would freeze the wrong contract. The owner's rule that every action a person
can take must also be an API call, and from there an MCP tool, started it.
The foundation is built: API keys (`api_keys`, shown once, stored as SHA-256,
scopes `read` · `write` · `spend` · `publish`), one caller resolution for the
cookie and the key, the service role narrowed to the key's owner for API
callers, one registry and runner with one error shape, `POST /api/v1/tools/:name`
and a stateless MCP endpoint at `/api/mcp` (`@modelcontextprotocol/sdk`). The
first domain is Replies: every inbox action is a tool, its route logic moved to
`lib/placements/` so the screen and the tool call the same function; the other
screens' writes and reads, and Generate now and Publish, followed (§4). OAuth
for MCP clients is built (November 2026): claude.ai and the Claude apps add
`https://gettrafficfa.st/api/mcp` as a custom connector and sign in on this
site's consent screen, with keys unchanged for Claude Code and scripts
(`lib/oauth/`, migration `20261110160000_oauth.sql`, `docs/API.md` "Connect
from claude.ai"). Remaining: Client ID Metadata Documents and step-up
authorization for OAuth, a sweep for spent codes, tokens and unused clients,
and the orchestrator calling tools. See `docs/API.md`.

**Phase 7 — Off-site placement.** 🔨 *Review queue shipped.* The product
makes a customer's own site citable and measures whether answer engines cite
it, but planted nothing where those engines actually read, which is where
AEO is won. Discovery now runs over three providers that degrade
independently — Reddit's read-only API, GitHub's public search (issues and
awesome-lists, no key, opt-in), and web search over the existing SERP provider
scoped to Reddit, GitHub, LinkedIn, X and a set of communities — with one
canonical identity per page so no thread becomes three rows. Qualification is
deterministic rules first (own site, closed surfaces, stale, promotional, no
overlap) and the agent second, each verdict naming who made it. Drafting and
the gate ship together: `placement-draft` writes the variants a surface calls
for, `auditDraft` refuses anything that is a pitch, a bare link, generic,
unverifiable or spam, and the inbox on Today (`/today`) is where a person reads,
edits (re-audited on save), copies, opens the original, publishes, and says
so — `published_manually` is the only "published" there is. The drafts are
written in the business's own voice (`Settings → Voice`,
`businesses.voice_settings`, `lib/voice/settings.ts`, `docs/VOICE.md`): a
tone, who is speaking, and what is true about the writer, the only personal
experience a draft may claim; the job deals each reply a different approach
so a stateless model does not converge on one shape, and the gate blocks the
sales close and counts the tells of promotional writing. Owned-surface
publishing and widening citation probing to placement URLs remain. The
principle throughout: the product finds and writes, a person publishes. See
`docs/PLACEMENTS.md`.

### 12.4 One login, several sites

Built (September 2026). `business_id` is the lookup key on the 18 site-scoped
tables; `user_id` and every RLS policy stayed exactly as they were, so the
isolation guarantee was never rewritten under live data. The selected site
lives in a cookie and is always resolved by picking from the user's own
businesses, never by filtering on what the client sent.

Ownership is enforced by the database too: on every table with `business_id`,
a customer's insert or update must name a business that customer owns (the
policy's `with check`), not only carry their `user_id`; the last two policies
were closed in November 2026. The rule and its test are in
`docs/MULTI_BUSINESS.md` "Writes name a site the user owns".

**The schema is fully in migrations.** `supabase/migrations/`, replayed in
order on an empty Supabase project, builds the production schema: every
table, column, constraint, index, RLS flag, policy, trigger and function.
The four core tables that were first made by hand in the dashboard
(`articles`, `businesses`, `keywords`, `subscriptions`) are created by
`20250101000000_baseline_core_tables.sql`, which runs first and is a no-op on
a database that already has them. Verified on 2026-11-16 by replaying all
migrations on an empty Postgres 16 with Supabase's `auth` and `storage`
stubbed and comparing the catalogue with production table by table: identical.
Nothing is created in the dashboard any more; a schema change is a migration.

What is deliberately NOT built is the paywall: `subscriptions` is still one per
account, because a customer who pays for several sites does not exist yet. The
plan for it, and why the connected Google account never has to match the login
account, are in `docs/MULTI_BUSINESS.md`.

### 12.5 Light and dark

Built (November 2026). Every page follows the device's colour scheme through
one set of CSS tokens swapped by a `.dark` class (`lib/theme.ts`,
`app/globals.css`); a person can pin Light or Dark in Settings → Account, kept
in the browser only. Components use the tokens; status colours carry a
`dark:` partner, and a test fails on one without it. The mark is drawn as a
mask in the text's colour, never as an `<img>` of `icon.svg`. See
`docs/THEME.md`.

### 12.6 Growth

Built (2026-11-14), phase 2 of the owner's simplification to four sections.
**Growth** (`/growth`) is the one place the numbers live: Results, the
AI Visibility dashboard and the Overview's measurements merged into three
blocks that each answer "am I growing?" over 7 or 28 days against the period
before (Replies on X, Google, AI answers), then the articles behind Google.
Its evidence page, `/growth/ai`, lists every AI answer of the period with
its sources, which is how a citation is verified by eye. One read
(`lib/growth/read.ts`) serves the routes and the tools (`get_growth`,
`list_ai_answers`); the old addresses (`/results`, `/visibility` and its
subpages) redirect with their query string (`lib/legacy-redirects.ts`, served by
`redirects()` in `next.config.ts`). Definitions in
`docs/LIFECYCLE.md` ("Growth"), the AI count in `docs/CITATIONS.md` ("One
count of asks"), the evidence in `docs/AI_VISIBILITY.md`.

### Removed: the public Citation Index (2026-11-16)

The public Citation Index (`/citation-index`, its methodology page, the free
check at `/check` and `POST /api/check`, the `ingest-`, `classify-` and
`probe-citation-index` crons, `lib/study/` and the `study-classify` agent)
was removed by the owner's decision of 2026-11-16. Its old addresses
answer a permanent redirect to `/` (`lib/legacy-redirects.ts`). The
internal measurement is untouched: article citation probes
(`ai_citations`, `lib/lifecycle/citations.ts`), AI Visibility (`aeo_*`)
and Growth's AI answers. The two matching primitives they shared with the
study, `isCompanySource` and `findMention`, now live in
`lib/domain/source-matching.ts`.

**Unused tables.** `study_editions`, `study_categories`,
`study_companies`, `study_probes`, `study_verdicts` and `study_checks`
(migrations `20260831120000_citation_index.sql`,
`20260831190000_check_snippet.sql`, `20260901120000_check_user.sql`) are
no longer read or written by any code. They keep their data in production;
the migrations stay as history. A future migration may drop them, with the
owner's approval, since a `drop` is destructive.

---

## 13. Principles

- Orchestration is code; inference is an agent's job.
- Structured, schema-validated output at every boundary.
- One implementation per concern; no logic in two places.
- No vendor name above the provider layer.
- Detectors may use patterns; fixers may not.
- Every run and every state transition is recorded, with its cause.
- Losing a publication beats publishing corrupted content.
