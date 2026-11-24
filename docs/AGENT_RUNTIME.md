# Agent runtime

How work actually executes. The design rationale is in `docs/ARCHITECTURE.md`;
this is the operational reference.

## Why jobs exist

Producing an article is several model calls plus external APIs. That does not
fit one serverless invocation, and a failure at the last step must not discard
the work before it. So production runs as a **durable job**: steps are executed
in order, each one checkpointed, and a run that stops resumes from where it got
to.

```
producer (cron, route, later an MCP tool)   →  enqueueJob()
worker tick (/api/jobs/tick, every 5 min)   →  claim_jobs() → runJob()
runJob                                      →  step → checkpoint → step → …
```

Producers never execute work. Execution happens in exactly one place, so
concurrency, retries and time budgets are configured once.

## Guarantees

- **Atomic claim.** `claim_jobs()` uses `FOR UPDATE SKIP LOCKED`, so several
  workers can tick concurrently without ever picking up the same job. A job
  whose lock expired (the worker died mid-run) becomes claimable again.
- **Completed steps never re-run.** Resumption reads `job_steps`; a step with
  status `completed` is skipped and its output is handed to the next step.
- **Yielding is not failing.** When the clock runs out the job goes back to
  `pending` with its attempt refunded, and the next tick continues it.
- **Retries are bounded.** A failed step schedules a retry with exponential
  backoff (1m, 2m, 4m … capped at 30m) until `max_attempts`, then the job fails
  and `onFailure` runs. A step may ask for a specific delay without consuming an
  attempt by throwing `RetryableStepError`. A `TerminalStepError` (a
  precondition the input does not meet, a setting nobody filled in) or an
  `LlmError` marked `retryable: false` (missing key, HTTP 401/402/403)
  fails the job on the first attempt, with that message as `last_error`:
  the next model and the next tick would fail the same way. A
  `TerminalStepError` is written for the person who asked (the route
  returns it as the reason) and is an outcome, not a defect: the worker
  records it on the job and the step row and does not send it to Sentry.
  Every other step failure is captured, tagged with the job type and step.
  A billing refusal of the whole LLM layer is neither: it pauses the job
  (see "When the model accounts cannot pay" below).
- **The model chain stays on text models.** The Gemini provider tries the
  configured tier model, then `FALLBACKS`, then whatever ListModels says the
  key can call — flash or pro only. A robotics, image or embedding name is
  not a fallback. A 404 walks the chain; a billing or auth refusal stops it.
  A call that never answers is cut off rather than held until the platform
  kills the function: listing models has 8 seconds, a generation 40. That
  cut-off is a failure of that model, so the chain and the fallback still
  run. Separately, the worker aborts whatever is in flight a few seconds
  before its own time budget ends and releases the lock. A killed function
  is not what frees the job. The Placements card stays on "writing" and
  keeps asking until the draft is there or the job's own reason is.
- **A failed call gets a second vendor, when one is switched on.** With
  `LLM_FALLBACK=anthropic`, any request Gemini fails, for any reason (credits
  depleted, a refused key, a key that is not set, an outage, an answer that
  never matched the schema), goes once to Claude with the same prompt, tier
  and options. Every text use takes this path: outline, writing, AEO audit,
  SERP analysis, image brief, video selection, knowledge extraction,
  internal links, refresh plan and write, placement qualify and drafts,
  prompt suggestions, keyword research,
  website analysis.
  `agent_runs.model` records which model answered. When both fail the step
  gets one `LlmError` carrying both reasons: retryable if either side could
  still succeed, sent to Sentry if either side was a defect, not when both
  accounts simply cannot pay. Our own abort is not a provider failure and is
  not retried elsewhere. Both sides are built on first need, so a missing
  `ANTHROPIC_API_KEY` never stops Gemini (it shows up next to Gemini's
  reason when it was needed), and a missing `GEMINI_API_KEY` is one more
  failure Claude takes. Without `LLM_FALLBACK` a missing Gemini key fails
  the call as it always did.
  Citation probes and image generation do not fall back: a probe answered
  by another engine would be recorded as the wrong engine's rate, and
  Claude does not render images.
- **A call can carry images (2026-11-11).** `LlmOptions.images` is a list of
  `{ mimeType, data }` (JPEG, PNG, GIF or WebP, base64) that the model reads
  with the prompt, placed before the text: Claude gets one `image` block of
  source `base64` per image (`messageContent`), Gemini one `inlineData` part
  (`contentParts`). Bytes, not URLs, for both: an image that cannot be
  fetched is known before anything is paid, and the caller records it.
  `fetchLlmImage`/`fetchLlmImages` (`lib/providers/llm/images.ts`) fetch them
  through `safeFetch` (8 s, at most 3.75 MB, which keeps Claude's 5 MB base64
  limit; the type is read from the bytes) and never throw: each result says
  `ok` or why not. The fallback layer passes images on unchanged, so Claude
  standing behind Gemini sees the same picture. Images are input tokens
  (Claude about w×h/750, at most about 1,600; Gemini 258 per 768-pixel tile),
  under the same agent budgets and daily AI spend ceiling. First users: the
  reply draft and Fix it, with the post's images (docs/PLACEMENTS.md, "The
  post's images").
- **The writer stays on a quality model, and what wrote an article is on
  record.** Found on 10 November 2026: most "quality" articles had been
  written by `gemini-2.5-flash`. No env var asked for it. The quality chain
  is `gemini-2.5-pro`, then `FALLBACKS` (`gemini-2.5-flash` first), and a
  refused pro call stepped to flash inside the same request, without a log
  line and without a trace on the run: `agent_runs.model` said flash and
  nothing said it was not the model asked for. `LLM_FALLBACK` never saw
  those calls, because for the fallback layer Gemini had answered. (The
  flash drafts took 12 to 36 seconds end to end, under the 40-second limit,
  so pro was refused, not timed out; the refusal itself was never logged,
  which is why its exact reason is not known. The articles of 13 to 28
  October were written by Claude Sonnet because Gemini as a whole was
  failing then and the fallback took everything.) Three things changed:
  - every usage now says who answered: `provider`, `fallback` (not the
    model the tier is configured for: a step down the chain, or the second
    provider) and `tierDowngraded` (a quality request answered outside the
    quality family). The `write` step's output carries `model`, `fallback`
    and `tierDowngraded`, the `revise` step's `model` and `fallback`, and
    `settle` repeats the writer's as `writerModel` / `writerFallback`;
  - a step down the chain is logged: `llm.model_step_down`, with the model
    that failed and its error;
  - the writer and the revision ask with `keepTier`. With a second provider
    configured, a quality request the first provider's quality family
    (Gemini: the configured model and the pro family; Claude: anything but
    Haiku) cannot serve goes to the second provider's quality model, not
    to the first one's fast model. With one provider alone there is nobody
    to hand over to: its chain stays the net, the fast model may still
    write, and the usage says so. If both quality models fail the step
    fails and the job retries.
  `LLM_WRITER_PROVIDER` gives the writer its own primary: with
  `LLM_WRITER_PROVIDER=anthropic` the writer and the revision ask Claude
  first and the default provider stands behind them, while every other
  agent stays on `LLM_PROVIDER`. Agents name a role
  (`getLlmProvider("writer")`), never a vendor; the registry is still the
  only place a vendor is chosen.
- **The article agents can alternate between providers by day.**
  `LLM_ARTICLE_ROTATION` (unset by default) decides for every model call of
  article production while it is set, over `LLM_WRITER_PROVIDER`. See "The
  article rotation" below.
- **Claude is shaped per model.** Haiku 5.5 serves `fast`, Sonnet 5.5
  serves `quality`. Claude 4.7 and later refuse a non-default temperature
  (HTTP 400), so they get an effort level instead (`low` for fast, `medium`
  for quality: thinking is billed as output, and the default is `high`).
  That includes Haiku 5.5, which thinks by default: it is sent
  `output_config.effort: "low"` and no temperature. Haiku 4.5 stays in the
  chain behind it, priced, and keeps the caller's temperature. The fast
  tier walks Haiku 5.5 → Haiku 4.5 → Sonnet 5.5, the quality tier Sonnet
  5.5 → Haiku 5.5 → Haiku 4.5 (Sonnet alone when the tier is strict). A 404
  or an overload walks to the next model; a refused key, a 402, the tier's
  monthly cap or a spend limit stops the walk, and an account refusal is
  not reported.
- **Budget survives resumption.** The per-article ceiling
  (`AGENT_BUDGET_USD`, default $0.50) is computed from what the job's agents
  already spent in `agent_runs`, so a resumed or retried run cannot start the
  budget over. The same holds for `placement-discovery` ($0.50) and
  `placement-draft` ($0.75): a draft retried after a failure gets what its
  earlier attempts left, not a fresh ceiling. `AGENT_BUDGET_USD` is parsed
  once, by `agentBudgetUsd()` in `lib/agents/contract.ts`; a value that is
  not a finite number above zero falls back to $0.50 with an
  `agent_budget.invalid_env` log line. `createBudget` reads a non-finite
  ceiling as zero (the first charge throws), never as no limit: a NaN
  ceiling used to compare false against every spend and never stop a run.

## When the model accounts cannot pay

On 2026-11-08 Gemini and the Claude fallback both ran out of credits and
nobody was told: the refusal was kept out of Sentry, every job spent its
attempts on it, customers were emailed the vendor's message, and the crons
kept buying searches for work that could not run. The layer now treats a
billing refusal as an account state with an owner, the operator.

- **What counts.** `LlmError.billingRefused` lists the providers that refused
  to pay when that refusal is the whole outcome: the primary refused with no
  fallback, or the primary and the fallback both refused. A refused primary
  behind a fallback that answered is not an incident; behind a fallback that
  timed out it is an ordinary retryable failure.
- **Pause.** Whoever catches it (the worker, the autopilot and Citation
  Index classify crons, which call a model directly, and the routes that
  call one inside the request: `POST /api/business/analyze`,
  `/api/keywords/suggest`, `/api/visibility/queries/suggest`) hands it to
  `recordLlmBillingRefusal` (`lib/llm-billing.ts`), which writes
  `provider_pauses` (`kind = 'llm'`, `paused_until = now + 1h`). Those
  routes then answer 503 with `LLM_CREDITS_RAN_OUT_MESSAGE` ("The AI
  provider's credits ran out. Try again once they're topped up."), never the
  vendor's error.
- **Jobs wait.** While the pause holds, `runJob` does not start an LLM-bound
  job (`produce-article`, `refresh-article`, `placement-discovery`,
  `placement-draft`; `isLlmBoundJob` in `lib/jobs/registry.ts`). The job goes
  back to `pending` with `run_after = paused_until`, its attempt refunded,
  `last_error` set to `LLM_PAUSED_MESSAGE`, and nothing reported. A step
  refused mid-run is handled the same way: its row stays `running` with the
  reason, the job is held, and the other LLM-bound jobs in that tick are held
  without asking. `aeo-run` and `search-console-ingest` call no model and keep
  running. The tick returns `paused` and `pausedUntil`; held jobs also count
  as `yielded`, which is the outcome callers of `runJobNow` see.
- **Articles stay queued.** `produce-article.onPause` moves an article that
  was only `generating` (before `validate`) back to `queued`; no
  `attempt_count` is spent and no email is sent. Research rethrows a billing
  refusal rather than checkpointing "skipped", so the article keeps its
  research when the pause lifts.
- **Crons skip.** `generate-articles` skips enqueueing and its tick (it still
  publishes), `discover-placements` enqueues nothing (discovery's Serper
  searches are only worth paying for when `qualify` can judge them),
  `refresh-articles` keeps measuring rank but enqueues no refresh,
  and `autopilot` keeps scheduling from the existing pool (free, and an
  empty day cannot be recovered) but generates no keywords. Each logs
  `{"event":"llm_billing","outcome":"cron_skipped","cron":…}`.
  `probe-visibility` and the citation probes call no LLM-layer model and are
  unaffected.
- **Retry.** When `paused_until` passes, the next run simply tries. Still
  refused: the pause is renewed for another hour, with no new alert that day.
- **Alert.** Once per provider per UTC day a Sentry `captureMessage`, level
  `fatal`, fingerprint `["llm-billing", provider]`; once per UTC day an email
  to `OPERATOR_EMAIL` (default: `CONTACT_EMAIL` in `lib/site.ts`). Dedupe is
  an insert into `operator_alerts` keyed by (alert, day). If that table
  cannot be written the Sentry event is still sent and the email is not.
- **Reading the pause fails open.** An unreadable `provider_pauses` (the
  migration not applied) means no pause: production is never stopped by the
  guard itself.
- **Ending a pause early.** After topping up, delete the row:
  `delete from provider_pauses where kind = 'llm';`. Held jobs keep their
  `run_after`; to run them now, `update jobs set run_after = now() where
  status = 'pending' and last_error like 'LLM credits are depleted%';`.

### What the customer hears

`articleFailedEmail` is not sent when the reason is a provider that cannot
pay or did not answer (`llmFailureKind` is `billing` or `unavailable`): that
article is only delayed, so it goes back to `queued` without an attempt
counted. Every other exhausted failure is emailed with the real attempt
count and a sentence of ours (`customerReason`); the raw error, which can be
a vendor's message, stays in `articles.last_error`.

## When the owner stops paying

A job is queued by a paying account and may run hours or days later: a
retry, a resume, a draft started just before the subscription ended. The
paywall at the route is not enough, so the worker asks again when the job
runs. The rule is the screens' own, read through the service role:
`hasPaidAccess` (`lib/paid-access.ts`).

- **Which jobs.** `isPaidJob` (`lib/jobs/registry.ts`): every LLM-bound type
  (`produce-article`, `refresh-article`, `placement-discovery`,
  `placement-draft`) and `aeo-run`, whose probes are paid answer-engine calls
  though no model of ours is asked. `search-console-ingest` is free and runs
  whoever the owner is.
- **Not paying: failed, once.** Before its first step (and on every resume),
  `runSteps` checks `job.user_id`. Without an active subscription the job is
  failed on that attempt with `JOB_SUBSCRIPTION_INACTIVE_MESSAGE`
  (`lib/jobs/types.ts`: "Subscription inactive: …"), no retry, no step run,
  nothing sent to Sentry: it is an account state, not a defect. The log line
  is `{"event":"jobs","outcome":"failed","reason":"subscription_inactive"}`.
  `onFailure` runs with that message; `produce-article` recognises it
  (`isSubscriptionInactive`) and puts the article back in `queued`, with the
  reason as `last_error` and no failure email, as the generation cron leaves
  a lapsed account's articles. A draft card shows the sentence as is.
- **Cannot tell: held.** A subscription that cannot be read neither runs the
  job (it might not be paid for) nor fails it (it might be): it goes back to
  `pending` for 5 minutes, its attempt given back, logged as
  `reason: "subscription_unreadable"`.
- **The crons.** Every per-customer sweep that spends asks the same question
  once per owner per run (`paidOwners`) and skips the owners who do not pay,
  one log line each, `{"event":"cron.unpaid_skipped","cron":…,"user_id":…,
  "reason":…}`, and a `skippedUnpaid` count in its response: `autopilot`
  (docs/AUTOPILOT.md), `generate-articles` (its own log lines,
  docs/SCHEDULED_AI_ARTICLES.md), `probe-visibility`, `probe-citations`,
  `refresh-articles` and `discover-placements`. The last three read a wider
  pool and cut it after leaving the lapsed owners out, so those cannot hold
  the slots. An unreadable subscription counts as not paid there (fail
  closed: the work waits for the next run).
- **Not gated.** `ingest-search-console`,
  `onboarding-emails` and `prune-tool-calls` (the audit log's 90-day
  retention, docs/API.md) spend nothing.

Tests: `tests/jobs/worker-subscription.test.ts`,
`tests/jobs/produce-article-failure.test.ts`, `tests/cron/unpaid-owners.test.ts`.

## When the account reaches its limit for AI work

Every account has a daily AI spend ceiling: the model cost its agent runs
recorded (`agent_runs.cost_usd`) over a rolling 24 hours, every site
together, against the account's own ceiling ($1 to $100, `account_limits`,
set by a platform owner on `/settings/costs`), else
`ACCOUNT_DAILY_SPEND_USD`, else $5 (`lib/limits/spend.ts`, docs/API.md
"Account limits"). It protects the platform's credits and is invisible to
the customer as an amount: what he reads
at the ceiling is "today's limit for AI work" and when it resets. The
routes and the tools refuse new paid work at the ceiling; the runtime's
half is below.

- **Jobs are held, not failed.** Before a paid job's first step, and on
  every resume, right after the subscription check, `runSteps` reads the
  owner's spend (`checkAccountSpend`). At or above the ceiling the job goes
  back to `pending` with `run_after` at the moment the rolling window frees
  (when the run that took the total over the ceiling is 24 hours old), its
  attempt given back, `last_error` set to `spendHeldMessage` ("Waiting:
  today's limit for AI work is reached. This resumes on its own at about
  14:05 UTC on Nov 15.", no amount),
  nothing reported. `onPause` runs with that sentence as `reason`, so
  `produce-article` puts a `generating` article back in `queued` with it as
  the cause, no attempt counted and no email. A job already running finishes
  the steps of that run: each is bounded by its own budget.
- **Cannot tell: held 5 minutes.** A spend that cannot be read neither runs
  the job nor fails it, as with an unreadable subscription: back to `pending`
  for 5 minutes, attempt given back, `reason: "spend_unreadable"` in the log.
  A missing `agent_runs` or `account_limits` table (a migration not applied)
  lets the job run, with one warning a minute.
- **The crons.** The per-customer sweeps that spend ask once per owner per
  run (`spendingOwners`, `lib/limits/owners.ts`, which asks `paidOwners`
  first) and leave out an owner at the ceiling, or whose spend cannot be
  read, logged as `{"event":"cron.spend_skipped","cron":…,"user_id":…,
  "reason":"spend_cap_reached"}` and counted apart from the unpaid
  (`skippedSpendCap`; `skipped_spend_cap` for `generate-articles`):
  `generate-articles`, `probe-visibility`, `probe-citations`,
  `refresh-articles`, `discover-placements`. `autopilot` treats it like the
  billing pause: it keeps scheduling from the existing pool (free; an empty
  day cannot be recovered, and the generation cron checks the ceiling again)
  and buys no keywords (`keywordsDeferredSpendCap`).
- **Unmeasured runs count.** A run that threw before it reported its usage
  records `cost_usd`, `input_tokens` and `output_tokens` as null, never 0
  (`lib/agents/runner.ts`); a run whose output was refused records what the
  model's answer cost; a run refused by the budget after it was recorded puts
  its cost on the completed row only. The ceiling counts each null-cost run
  at a conservative estimate for its agent (`lib/limits/estimates.ts`), and
  the owner's costs page shows that part as an estimate. The job budgets above
  still read a null cost as 0, as before: they bound one job, the ceiling
  bounds the account.
- **Ending it early.** A platform owner raises the account's ceiling on
  `/settings/costs` (the customer cannot). Held jobs keep their
  `run_after`; to run them now, `update jobs set run_after = now() where
  status = 'pending' and (last_error like 'Waiting: today''s limit for AI
  work%' or last_error like 'Waiting: today''s AI spend limit%');` (the
  second is the wording before 2026-11-14).

Tests: `tests/jobs/worker-spend.test.ts`, `tests/limits/spend.test.ts`,
`tests/cron/unpaid-owners.test.ts`, `tests/cron/generate-articles-paid.test.ts`,
`tests/agents/runner.test.ts`.

## Steps must be safe to re-enter

A step may run again after a failure elsewhere. Write them so that is harmless:
persist with the article id as the key, and never append.

When a step's own output is the problem — the pipeline judged the article
unusable — the step deletes the checkpoints that produced it before failing, so
the retry genuinely regenerates instead of re-validating the same text. That is
what `validate` does in the production workflow.

## Adding a workflow

1. Define it: `lib/jobs/workflows/<name>.ts`, exporting a `Workflow` with a type
   string and ordered steps.
2. Register it in `lib/jobs/registry.ts`.
3. Enqueue it: `enqueueJob({ supabase, userId, type, input, articleId })`.

The worker needs no changes.

## Adding an agent

1. `lib/agents/<name>.ts`: zod schemas for input and output, plus `run()`.
2. Call it through `runAgent(agent, input, ctx, supabaseRecorder(supabase))` —
   never directly, or the run goes unrecorded, and its cost escapes the
   account's daily spend ceiling.
3. Add its conservative per-call figure to `UNMEASURED_RUN_ESTIMATES`
   (`lib/limits/estimates.ts`); without one, a run of it whose cost was not
   recorded counts at the table's dearest figure.
4. Bump `version` whenever the prompt or the schemas change behaviour, so a
   regression can be attributed to a revision.

Agents receive data and return data. They never write to the database, never
decide what runs next, and never call another agent.

## Article production

`produce-article` — steps `arm` → `research` → `outline` → `write` →
`validate` → `audit` → `revise` → `settle` → `enrich` → `knowledge`.

- **arm** makes no call. It asks the provider registry which provider this
  job's agents ask first (`chooseArticleArm`) and checkpoints the answer:
  `{ arm, day, rotation }`, or `{ arm: null }` when no rotation is
  configured. See "The article rotation".
- **research** reads the real search results and decides whether an article
  should be written at all (docs/INTELLIGENCE.md, "What research decides"):
  it holds the article when research fails, and skips it when the results
  are tools and product pages.
- **outline** plans the article: sections phrased as questions, each with the
  direct answer that opens it. This is where AEO is decided. It is given the
  search evidence, the business's first-hand facts (Settings → Voice) and
  the title, heading and FAQ rules.
- **write** produces the document from that plan and persists `raw_content`
  immediately. Its output records the model that wrote it.
- **validate** runs the content pipeline and the quality gates, with the
  business's facts and the research evidence as what the editorial gates
  check against. It stores the draft (or throws to force regeneration) and
  leaves the article in `generating`.
- **audit** reads the WHOLE body, scores it for citability, writes the
  document's `metaTitle` and `metaDescription`, and records findings under
  `quality_report.aeo`, each with a `category` (since 2026-11-12, version
  4). It is given the owner's Facts for articles, the site's address and
  the research evidence; a finding about figures that are all the author's
  own is cleared in code to an info suggestion. It never rewrites the body.
- **revise** runs ONE rewrite (`article-revision` agent, quality tier) when
  the editorial gates raised anything or the audit has a critical or warning
  finding, with every problem named. Nothing found: no call. It is skipped,
  with the reason recorded, when less than $0.10 of the article's budget is
  left. The rewrite is its own checkpoint so a resumed job never pays for it
  twice.
- **settle** re-runs the gates and the audit once on the revised draft,
  keeps the better of the two drafts, and moves the article out of
  `generating`: `needs_review` when a gate still says review or the audit
  has a critical finding in a blocking category (invented fact, wrong
  link, factual error, unsafe: `lib/content/quality/blocking.ts`),
  `generated` otherwise. Since 2026-11-12 the revision is kept only when it
  is better: fewer blocking problems, then fewer criticals, then fewer gate
  issues, then a higher score; a tie keeps the original. A revision that is
  not an article is discarded. `quality_report.revision` records whether it
  ran, the problems named, the issues, findings, word count and score
  before and after, which draft was `kept` and why; `quality_report.blocking`
  the reasons it is held. Both the writing and the revision are rows in
  `agent_runs`, as are both audits. There is never a second revision.

- **enrich** adds media when the business enabled it (Settings → Autopilot → Images and video):
  the image-brief agent plans a hero (and in-article scenes, when the business
  set a cap above zero), a scene check in code refuses abstract scenes,
  providers render, assets are resized, encoded and stored, inline figures are
  embedded tree-based; a YouTube candidate is embedded only when the
  video-select agent clears a confidence threshold. Every failure here
  degrades to "less media", never to a failed article, and is recorded with a
  reason for the owner (`canonical.media.skipped`) and the operator. A billing
  refusal from the image provider holds images, and only images, for an hour.
  See `docs/MEDIA.md`.

The draft exists after `validate` but is not publishable until `settle`: an
article with an invented price must not sit in `generated` for the seconds
the audit takes, where the publishing cron could pick it up. If the job is
held or fails between the two, `onPause` / `onFailure` settle the article
from the validation alone (never `generated` over a gate that says review).
`enrich` and `knowledge` only enrich it.

What one article costs in model calls, from the October 2026 runs in
`agent_runs` (an estimate, not billing truth): about $0.07 without a
revision and about $0.12 with one, when the writer runs on Claude Sonnet
and the other agents on Gemini Flash (writing $0.045, revision $0.05, each
audit $0.004, outline $0.007, the rest under $0.01 together). With every
agent on Claude the fast agents now run on Haiku 5.5 ($0.10 / $0.50 per 1M
tokens, a tenth of Haiku 4.5), which puts that arm at about $0.05 to $0.06
without a revision and $0.10 to $0.11 with one; with every agent on Gemini
the writer is `gemini-2.5-pro`, whose thinking is billed as output, and the
arm is expected at $0.07 to $0.10 without a revision and $0.13 to $0.18
with one. The two arm figures are computed from prices and the token
counts above, not measured: no article has been written on either arm end
to end yet, and `compare_article_providers` is what will say.
All inside the $0.50 ceiling. A finished article (generated, published, needs_review) can be
rewritten from the calendar: **Regenerate** enqueues the same workflow as a
first run.

### The article rotation

Decided by the owner on 2026-11-10: the article agents alternate between
the two model providers day by day, so that after some weeks there is data
to decide, task by task, which provider keeps which task
(docs/CONTENT_PIPELINE.md, "The provider rotation").

- **The switch.** `LLM_ARTICLE_ROTATION`, unset by default, is a comma
  list of provider names: `gemini,anthropic`. Setting it is the consent to
  spend on each provider named; each one's key must be set. A name the
  registry cannot build stops the job at the `arm` step with the variable
  named (`Unknown LLM provider in LLM_ARTICLE_ROTATION: "…"`); the article
  goes back to the queue like any provider that is unavailable.
- **The arm of the day.** index = (days since 1970-01-01, UTC) mod (list
  length). 2026-11-10 is day 20767, so with `gemini,anthropic` it is an
  `anthropic` day and 2026-11-11 a `gemini` day. The day changes at 00:00
  UTC. A list of one is that provider every day; a name may be repeated to
  give it more days.
- **Who is on the arm.** Every model call of `produce-article`: the SERP
  analysis, the outline, the writer, the revision, the audit (both
  passes), the image brief, the video selection, the knowledge extraction
  and the internal links. The arm's provider is their primary and the next
  different provider in the list stands behind it as the fallback (with a
  list of one, the default provider). A day is one arm, so an article is
  one arm.
- **One arm per job.** The `arm` step stores the arm once
  (`job_steps`, step `arm`; it ends up in `jobs.result.arm` with the other
  outputs). A completed step is never run again, and `validate` throwing
  away the `outline` and `write` checkpoints leaves it in place: a job that
  is retried, held, or resumes after midnight keeps its arm. A job that
  was already under way when the step was added stores `{ arm: null }` and
  finishes on the providers it started with.
- **Precedence.** Rotation set: it decides for the article agents and
  `LLM_WRITER_PROVIDER` is ignored for them; the first use in a process
  logs `llm.article_rotation` with the rotation, the arm, the fallback and
  `ignored: "LLM_WRITER_PROVIDER=…"` when that variable is set. Rotation
  unset: exactly the behaviour before it existed, `LLM_WRITER_PROVIDER`
  included. Everything that is not article production (reply drafts, AI
  Visibility, discovery, refresh, keyword research, the back-link pass)
  calls `getLlmProvider()` without an arm and is never touched. Taking a
  provider out of the list stops the spend on it for jobs already under
  way too: an arm that is no longer in the rotation is not honoured.
- **Quality stays quality.** The writer and the revision ask with
  `keepTier` on both arms: Sonnet 5.5 on a Claude day, `gemini-2.5-pro` on
  a Gemini day, and when the day's quality family cannot serve, the other
  provider's quality model, never a fast one.
- **What is recorded.** The arm, once, on the job. Per agent run,
  `agent_runs.llm_calls`: one entry per model call with `provider`,
  `model`, `fallback`, `tierDowngraded`, tokens and cost. When the day's
  provider cannot serve (an outage, an account that refuses for billing)
  and the other one answers, the run is recorded with the other provider
  and `fallback: true`, as before; the comparison counts it apart.
- **No vendor above the provider layer.** The workflow stores a name the
  registry gave it and hands it back (`AgentContext.llmArm` →
  `getLlmProvider(role, arm)`); nothing above `lib/providers/llm/` knows
  what the names are.

Tests: `tests/providers/llm-article-rotation.test.ts` (day to arm, UTC
boundaries, a list of one, an unknown name, precedence, unset, callers
without an arm, Haiku 5.5's request, the fallback recorded),
`tests/jobs/produce-article-arm.test.ts` (the arm kept across midnight, a
retry and a rewrite; every agent handed it; `llm_calls` written).

## Search Console ingest

`search-console-ingest` — one step, `ingest`. Same window and attribution as
the daily sweep (`ingestBusinessSearchConsole`). It exists so a first property
selection does not wait until 07:00 UTC: the OAuth callback enqueues, "choose
this property" and `/results` wait up to 45s via `runJobNow`, and a missing
watermark is the only thing that kicks. No published article with a live URL
is a skip, not a watermark — marking `last_synced_on` without fetching would
lose the 90-day first pull. `onFailure` records the error on the connection
row. See `docs/ANALYTICS.md`.

## Debugging a run

| Question | Where to look |
| --- | --- |
| What did the model actually return? | `articles.raw_content` |
| Why was it not published? | `articles.quality_report` |
| Where did the job stop? | `jobs.current_step`, `jobs.last_error`, `job_steps` |
| What did each agent cost and how long did it take? | `agent_runs` (`cost_usd` null: not measured) |
| Which provider and model answered, and was it the fallback? | `agent_runs.llm_calls` (null: not recorded) |
| Which arm of the rotation was the job on? | `job_steps` where `step = 'arm'` (`output.arm`), `jobs.result.arm` once completed |
| Why is a paid job waiting? | `jobs.last_error` (`Waiting: today's limit for AI work …`; before 2026-11-14 `Waiting: today's AI spend limit …`), `jobs.run_after` |
| How did the article get into this state? | `article_events` |
| What was sent to the customer's site? | `publish_attempts.payload` / `.response` |

Set `CONTENT_TRACE=1` to get full content snippets in the logs outside
development.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `gemini` | Which provider implementation to use (`gemini` or `anthropic`) |
| `LLM_MODEL_FAST` | `gemini-2.5-flash` | Gemini model behind the `fast` tier |
| `LLM_MODEL_QUALITY` | `gemini-2.5-pro` | Gemini model behind the `quality` tier |
| `LLM_FALLBACK` | unset | `anthropic` (or `claude`) sends any request the primary failed to Claude. Off unless set: a key being present is not consent to spend |
| `LLM_WRITER_PROVIDER` | unset | `anthropic` (or `claude`) or `gemini`: the article writer and its revision ask this provider first; the default primary stands behind them. Every other agent is unaffected. Naming it is the consent to spend on it. Ignored for the article agents while `LLM_ARTICLE_ROTATION` is set |
| `LLM_ARTICLE_ROTATION` | unset | A comma list of providers, e.g. `gemini,anthropic`: every article agent asks the provider of the UTC day first (day number mod list length), the next one in the list stands behind it, and a job keeps the arm it started with. Takes precedence over `LLM_WRITER_PROVIDER` for the article agents. Naming a provider is the consent to spend on it. See "The article rotation" |
| `ANTHROPIC_API_KEY` | unset | Claude key, read only when `LLM_PROVIDER`, `LLM_FALLBACK`, `LLM_WRITER_PROVIDER` or `LLM_ARTICLE_ROTATION` names `anthropic` |
| `ANTHROPIC_MODEL_FAST` | `claude-haiku-5-5` | Claude model behind the `fast` tier ($0.10 / $0.50 per 1M tokens in / out, prompts up to 100K tokens). `claude-haiku-4-5` ($1 / $5) stays in the chain behind it |
| `ANTHROPIC_MODEL_QUALITY` | `claude-sonnet-5-5` | Claude model behind the `quality` tier ($2 / $10) |
| `AGENT_BUDGET_USD` | `0.50` | Ceiling per article, across every agent and retry. Not a finite number above 0: the default, logged |
| `ACCOUNT_DAILY_SPEND_USD` | `5` | Daily AI spend ceiling of every account without its own (Settings → Billing, $1 to $100). Not a finite number above 0: the default, logged (`spend.invalid_env`) |
| `OPERATOR_EMAIL` | `CONTACT_EMAIL` | Where operator alerts go (LLM billing refusal, once a day) |
| `CONTENT_TRACE` | unset | `1` forces verbose tracing in production |
| `IMAGE_PROVIDER` | `imagen` | Default image provider (per-business override in settings) |
| `OPENAI_API_KEY` | unset | Enables the `openai` image provider |
| `YOUTUBE_API_KEY` | unset | Enables video enrichment |
| `X_API_ENABLED` | unset | `1` (or `true`) turns the official X API on for the platform: the daily X search (job `x-post-discovery`, LLM-bound like discovery), the daily read of posted replies' numbers, and the 5-minute search for the link of a reply marked as posted (`/api/cron/x-reply-links`, at most 10 searches a run; docs/PLACEMENTS.md, "The link of your reply, found on X"). Needs `X_API_BEARER_TOKEN` too; the token alone spends nothing. No per-site switch since 2026-11-24: every site whose owner pays takes part, under per-site and per-run bounds and the monthly cap (docs/PLACEMENTS.md, "What bounds the cost now"). docs/PLACEMENTS.md, "Fresh posts and reply numbers from the X API" |
| `X_API_BEARER_TOKEN` | unset | X's app-only Bearer token. Read-only use: recent search and lookup by ids; no write endpoint is ever called |
| `X_API_MONTHLY_CAP_USD` | `20` | Hard cap on the platform's estimated X spend per calendar month (UTC), checked before every call against `provider_spend`. Not a number ≥ 0: the default. At the cap X calls stop until the 1st, with one operator alert a month |

The `/api/jobs/tick` cron runs every 5 minutes and is protected by
`CRON_SECRET`, like every other scheduled endpoint. After the jobs it also
publishes due articles whose production just finished (since 2026-11-10; see
docs/SCHEDULED_AI_ARTICLES.md), at most 3 per tick, under the same atomic
delivery claim as the daily run. Every one of them checks
it through `isCronAuthorized` (`lib/cron-auth.ts`): a constant-time
comparison of SHA-256 digests, failing closed when `CRON_SECRET` is unset.
