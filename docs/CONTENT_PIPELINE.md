# The content pipeline

> Scope: this document covers the **validation pipeline** — how raw LLM output
> becomes a Canonical Article that is safe to publish. For the platform as a
> whole (agents, tools, providers, knowledge graph, lifecycle, SEO/AEO), see
> **`docs/ARCHITECTURE.md`**; this pipeline is its *Validation* stage and is
> meant to be reused for every LLM-produced artifact, not only articles.

GetTrafficFast is a content **platform**: it generates articles with an LLM and
delivers them to any number of destinations. This document describes the
architecture that guarantees a destination only ever receives a valid document.

No destination is a special case. A custom site is one webhook receiver among
the others; WordPress, Ghost, Shopify, Medium and anything else plug in the same way.

## The shape of the system

```
Generation           lib/gemini/article.ts        model call, returns RAW text
     ↓
Raw output           articles.raw_content         persisted, never transformed
     ↓
Validation           stages/validate.ts           is there anything to work with?
     ↓
Extraction           stages/extract.ts            isolate the article from its envelope
     ↓
Normalization        stages/normalize.ts          any format → HTML (GFM parser)
     ↓
Sanitization         stages/sanitize.ts           tree-level tag/attribute allowlist
     ↓
Canonical Article    stages/canonicalize.ts       the one internal representation
     ↓
Quality gates        quality/gates.ts             publish | needs_review | regenerate
     ↓
Audit + one revision produce-article workflow     findings named, one rewrite, gates again
     ↓
Publisher Adapter    lib/publishing/adapters/*    Canonical → destination payload
     ↓
Provider             the customer's site          WordPress REST, signed webhook, …
     ↓
Delivery             publish_attempts             payload + response recorded
```

Orchestration lives in `lib/content/pipeline.ts`; generation and publishing
*policy* lives in `lib/content/service.ts`, which is the only thing the cron and
the manual routes call. There is exactly one implementation of each concern.

## The Canonical Article

`lib/content/types.ts`. The LLM may emit Markdown, HTML, a mix, or something new
next year — inside the platform there is one representation, and everything
converges on it before anything else happens.

```ts
interface CanonicalArticle {
  schemaVersion: number;
  articleId: string;        // stable identity, for idempotent upserts
  title: string;            // plain text
  bodyHtml: string;         // sanitised, semantic, NO <h1>
  headings: { level: 2|3; id: string; text: string }[];
  excerpt: string;
  metaDescription: string;  // the audit's, once it has run; the first paragraph before
  metaTitle?: string;       // the audit's, ≤ 60 chars; absent → use `title`
  wordCount: number;
  slug: string;
  keyword: string;
  language: string;
  scheduledDate: string | null;
}
```

Invariants, asserted by the gates on every run:

- `bodyHtml` contains no `<h1>` — the title travels in its own field, so no
  destination renders it twice;
- every `h2`/`h3` carries a unique `id`, and `headings` mirrors them in document
  order;
- `title`, `excerpt` and `metaDescription` are plain text.

## Why parsers, not regular expressions

The previous implementation manipulated article HTML with regular expressions.
It failed in production the way string-level markup handling always eventually
fails: a `<h2>` *mentioned* inside prose was treated as a real element, the
match ran forward to the next real `</h2>` hundreds of lines away, and the id
built from that span became the heading. The article that reached the customer's
site carried the model's brief as its title.

So the rules are:

- **Markdown → HTML** is done by a GFM parser (`marked`). Headings, paragraphs,
  lists, blockquotes, code blocks, inline code, links, images and tables are its
  responsibility, and all of them are covered by tests.
- **Every HTML operation** happens on a parsed tree (`node-html-parser`).
  Structural manipulation cannot run past an element boundary, because there are
  no boundaries to run past — only nodes.
- **Detectors may use patterns; fixers may not.** A gate that notices leftover
  Markdown routes the article to a human. Nothing anywhere substitutes
  characters in an article to make it look right.

## Extraction: how the article is found

Models sometimes emit a plan before the article. Extraction cuts the document at
the first line that *starts* with `<h1` or `# `. The rule is structural: a
heading mentioned mid-sentence ("start with `<h1>`") is never at the start of a
line, so it cannot be mistaken for the document. Nothing is rewritten — the text
is cut at a boundary, and whatever was cut is reported as `PROMPT_LEAKAGE`
evidence, which sends the article to review.

## Quality gates and the three outcomes

| Outcome | Meaning | What happens |
| --- | --- | --- |
| `publish` | every check passed | proceeds to the publisher adapter |
| `needs_review` | plausible article, something is off | status `needs_review`, content kept, owner emailed, **never auto-published** |
| `regenerate` | the output is not an article | retried like any generation failure; dead-letters to `failed` after 3 attempts |

Checks: presence of a title, minimum length (hard and soft), at least two `<h2>`
sections, outline/anchor consistency, no `<h1>` left in the body, no Markdown
residue, no prompt leakage or chain-of-thought, coherent metadata, and the
sanitiser's report of anything it had to remove.

### Editorial gates

Since 10 November 2026 the gates also read what the article *says*
(`quality/tells.ts`, `quality/claims.ts`). They are still detectors: they
name the problem and never change a character. Each one sends the draft to
the workflow's single revision; three of them also block publication if the
revision does not remove the problem.

| Code | Fires when | Action |
| --- | --- | --- |
| `STOCK_PHRASE` | a stock opening or closing ("In today's … landscape", "is rapidly evolving", "no longer a luxury but a necessity", "offers an unparalleled solution", …; the list is `ARTICLE_TELLS`, the same idea as the Placements `AI_TELLS`) | warn |
| `TITLE_STYLE` | the title is over 60 characters or uses Mastering / Unlock / Ultimate / Definitive / Blueprint / Unleash | warn |
| `TITLE_UNDELIVERED` | the title says "ranked" with no ordered list, table or numbered entries; "compared" / "vs" with no table; "N ways" with no N of anything | warn |
| `ARTICLE_TOO_LONG` | more than 1,800 words (900–1500 is the target, and a ceiling) | warn |
| `HEADING_BLOAT` | more than 10 H2s, or two or more H3s (outside the FAQ) whose section is under 150 words | warn |
| `THIN_FAQ` | an FAQ with fewer than 3 questions | warn |
| `PRODUCT_MENTION` | the business is named in the intro, outside the closing section, in more than one sentence, or with a superlative (not read when the keyword names the business) | warn |
| `LOOKALIKE_LINK` | a link or a written address whose host spells the business name, or carries its real host's first label under another ending, and is not the business's `website_url` host or a subdomain of it | **review** |
| `UNSUPPORTED_NUMBER` | a price, a percentage, a rating ("N out of 5", "N stars") or a hedged estimate ("typically N") whose figure appears neither in the owner's Facts for articles (Settings → Voice; until 12 November 2026 About you, the notes and the description) nor in the research evidence | **review** |
| `PRIVATE_FACT` | since 12 November 2026: a figure of 10 or more, in any shape ("342 weekly impressions"), that is in About you and in neither Facts for articles nor the research evidence. About you is for replies; the owner keeps weak early results off the blog (docs/VOICE.md) | **review** |
| `SHORT_VERSION` | since 15 November 2026: the body does not open with the short version (a first paragraph that starts with the bold label, "The short version:" or its translation), or it runs over 120 words ("The article's anatomy", below) | warn |
| `QUESTION_HEADINGS` | fewer than half of the section headings are questions (the FAQ, the data section and Read next are not counted; an article with fewer than two is not judged) | warn |
| `DATA_SECTION` | a "From our data" section when the owner's Facts for articles hold no figure that may go in it, or holding a weak early figure (warn); a figure of 10 or more, or a percentage, in it that is in no fact at all (**review**: a number presented as the site's own data that is not its data) | warn / **review** |

Every editorial gate reads the body without its Read next block (the
knowledge step's list of other articles, docs/KNOWLEDGE.md): its titles
are not the article's prose, its list is not the article's list, and it is
not the closing section `PRODUCT_MENTION` looks for.

The numbers gate reads only those four shapes, outside `<pre>` and `<code>`.
Years, list counts, step numbers and "100%" are never claims. It needs to be
told what to compare against (`gateContext.facts` / `.evidence`, passed by
`produce-article`); a caller that passes neither does not run it. An article
with an unsupported figure does not publish on its own: it is `needs_review`,
with the sentence quoted in the reason.

### The revision

Until 10 November 2026 an article was produced in one pass and the audit's
findings were stored and never acted on. Now, after the audit, the
`produce-article` workflow runs ONE rewrite when the editorial gates raised
anything or the audit has a critical or warning finding, names every problem
to it, re-runs the gates and the audit once, keeps the better draft, and
settles the article: `needs_review` if a gate still says review or the audit
has a critical finding in a blocking category, `generated` otherwise (since
2026-11-12; "What may hold an article", below). Nothing found means no
rewrite and no cost.
The steps, the budget rule and what is recorded are in
docs/AGENT_RUNTIME.md, "Article production".

Losing a publication is always preferable to publishing corrupted content. A
`needs_review` article keeps everything: raw output, canonical document and the
report. From the calendar the owner can read the failed checks and either
**Regenerate** (`POST /api/generate-now`) or **Publish anyway** — the manual
publish from `needs_review` is the human approval path. The same **Regenerate**
action is on generated and published cards, so a finished article can be
rewritten (for example after turning images on) without deleting it.

## The article's anatomy (2026-11-15)

Since 15 November 2026 every article of every customer has the same
anatomy, because an answer engine quotes a passage that states
the answer at once, under the question it answers. Three parts, and what
enforces each. The pure readers are `lib/content/anatomy.ts`; the checks
are `lib/content/quality/anatomy.ts`.

**A. The answer first, questions as headings.**

- The outline (version 6) writes `shortVersion`: the direct answer in 3 to 6
  sentences. The writer (version 4) puts it right under the `<h1>`, before
  the introduction, as `<p><strong>The short version:</strong> …</p>`, the
  label in the site's language (`anatomyLabels`: "In breve", "En resumen",
  "En bref", "Kurz gesagt"). It is the paragraph an engine can quote alone:
  no teaser, no business name.
- Most `<h2>` are the questions people ask (People also ask, the plan's
  questions), each answered in its first one or two sentences. The outline
  is asked for it; and code gives the writer the section's `question` as
  its H2 whenever the planned heading is not a question (`sectionHeading`).
  The FAQ and its `FAQPage` are unchanged.
- The excerpt (and the meta description, until the audit writes its own) is
  built from the short version's answer without its label
  (`withoutShortVersionLabel` in canonicalisation).
- Enforced softly: `SHORT_VERSION` and `QUESTION_HEADINGS` are warnings in
  `REVISABLE_ISSUES`, so a draft without them goes to the one revision, which
  is told how to fix each; they never hold an article
  (`lib/content/quality/blocking.ts` is unchanged). The audit (version 5) is
  told the short version is by design, so it is not reported as repetition.

**B. "From our data" only when there is real data.**

- `articleDataFacts` splits the owner's Facts for articles into sentences
  (`factSentences`, lib/voice/staleness.ts) and keeps those with a
  measurement: a figure that is not a date or a year (dates are read out
  with the staleness reader, `datesIn`).
- **The weak-traction rule.** A sentence about the site's own traction (a
  word of revenue, customers, users, sites, stores, visits, impressions,
  clicks, followers, conversions… in the five languages) with no verb of a
  study (tested, analysed, measured, surveyed…) is withheld when any of its
  figures is a percentage, zero, a revenue under 10,000 or a count under
  1,000 (`WEAK_REVENUE_BELOW`, `WEAK_COUNT_BELOW`). "We publish for 14
  sites", "12 paying stores", "MRR is €300", "9 to 342 impressions, 0 clicks"
  stay out; "we tested 400 prompts between September and November 2026"
  and "customer sites earned 1.2 million impressions" go in. When in doubt
  a fact is withheld: leaving a true figure out costs nothing, advertising a
  weak one costs the owner (docs/VOICE.md, 12 November 2026). The withheld
  facts are still Facts for articles: the body may state them as before;
  only this section may not.
- With usable facts, the writer and the revision are given them and asked
  for ONE short section, `<h2>From our data</h2>` (localised; "How we
  measured this" is read too), before the FAQ, stating those figures as the
  owner gives them, what each measures and the period, and nothing else; or
  no section if none bears on the article. Without usable facts they are
  told to write no such section.
- `DATA_SECTION` checks it: a figure in it that the owner never gave holds
  the article (review), the only objective problem of the three parts; a
  section with nothing it may state, or with a weak figure, goes to the
  revision. `UNSUPPORTED_NUMBER` and `PRIVATE_FACT` run as before.
- The JSON-LD gains a `Dataset` for that block only (`extractDataset`,
  lib/publishing/seo.ts): name, the section's text as description, the
  period it writes as `temporalCoverage` (English month names and years are
  read; `null` when it names none, never guessed), the business as creator.
  On this site's blog (docs/BLOG.md) and in webhook payload v6 (`dataset`,
  docs/NEXTJS_WEBHOOK_RECEIVER.md). WordPress receives the section in the
  body and no JSON-LD, as with the FAQ. No section, no schema.

**C. Internal links and Read next** (docs/KNOWLEDGE.md, "Read next"): up
to eight links in the body from the same one call of the links agent
(version 2), and a Read next block of three related live articles appended
by code, with no call, so an article on a site with enough published
articles has 6 to 12 internal links. It is part of `bodyHtml`, so the blog,
the webhook (`html` and `body_html`), WordPress and Copy HTML / Copy
Markdown all carry it.

Not built: a call-to-action line to the site's pricing or product page.
The business profile has no such page on record (`businesses` has
`website_url`, `sitemap_url` and `blog_url`, nothing else), and an address
is never guessed. This site's own blog keeps the line it already had under
every post.

**What it costs.** No extra model call per article. The rules ride in the
outline and writer prompts that already run; an article without the
anatomy uses the one revision the workflow already has (more articles may
now use it); Read next is chosen by code; the links agent is the same one
call with a higher cap.

**What is not verified until the next real article**: whether the writer
keeps the short version under 120 words, how often the revision is
triggered by the new checks, and whether a real Facts for articles text
yields usable measurements. The gates and `quality_report` will say.

Tests: `tests/content/anatomy.test.ts` (labels, the short version,
question headings, the weak-traction rule, the period, the Read next block),
`tests/content/anatomy-gates.test.ts` (each check, the hold only for an
invented figure, Read next not read as prose, the excerpt),
`tests/agents/article-prompts.test.ts` ("the article's anatomy"),
`tests/jobs/produce-article-knowledge.test.ts`,
`tests/knowledge/read-next.test.ts`, `tests/blog/anatomy.test.ts`,
`tests/blog/structured-data.test.ts` ("Dataset"),
`tests/publishing/webhook-payload.test.ts` ("v6").

## Publisher adapters

`lib/publishing/`. One interface:

```ts
interface PublisherAdapter {
  readonly type: IntegrationType;
  testConnection(): Promise<void>;
  deliver(article: CanonicalArticle): Promise<DeliveryResult>;
}
```

An adapter maps a Canonical Article onto its destination's API and performs the
delivery. It never parses Markdown, never sanitises, never extracts a title,
never touches content with a regular expression. Shared HTTP concerns (timeout,
network-error wording) live in `lib/publishing/http.ts`, so adapters differ only
in the API they speak.

Adding a destination: implement the interface, add a branch to
`lib/publishing/registry.ts`, add the card in `/settings/integrations`. Nothing
upstream changes.

The webhook payload is a **public contract** (see
`docs/NEXTJS_WEBHOOK_RECEIVER.md`) and is pinned by
`tests/publishing/webhook-payload.test.ts`: v1 fields are frozen, v2 fields are
additive, and the test fails if a key moves.

## Observability

Persisted per article: `raw_content` (exactly what the model returned),
`canonical` (the document), `quality_report` (decision, issues, per-stage
timings). Per delivery: `publish_attempts.payload` and `.response`.

Logged with one correlation id (`lib/content/trace.ts`): `content.pipeline` for
the run, `content.delivery` for the hop to the destination. Outside production
(or with `CONTENT_TRACE=1`) the lines include content snippets; in production
they carry shapes only — lengths, issue codes, decisions.

## Tests

`npm test` (vitest). The suite exists so the pipeline can be changed safely:

- `tests/content/normalize.test.ts` — every Markdown construct converts correctly;
- `tests/content/sanitize.test.ts` — unsafe markup removed, unknown tags unwrapped
  without losing text;
- `tests/content/pipeline.test.ts` — end to end, including the **real production
  failure** as a fixture, plus determinism and idempotence;
- `tests/content/invariants.test.ts` — no heading lost, no paragraph altered, no
  words dropped, canonical contract upheld;
- `tests/content/gates.test.ts` — each gate fires when it should and stays quiet
  when it shouldn't;
- `tests/content/editorial-gates.test.ts` — the editorial gates against the
  sentences production published, and against what must not trip them (years,
  list counts, step numbers, figures the business or the research supplied);
- `tests/jobs/produce-article-revision.test.ts` — the revision runs once and
  only when needed, it is kept only when better, a still-wrong article waits
  for a person only for a blocking reason, the intent gate skips, failed
  research holds;
- `tests/content/blocking.test.ts` — what may hold an article, the author's
  own figures, the choice of draft, the reasons the calendar shows;
- `tests/content/anatomy.test.ts`, `tests/content/anatomy-gates.test.ts` —
  the article's anatomy (2026-11-15) and its checks;
- `tests/publishing/webhook-payload.test.ts` — the receiver-facing contract.

## What the audit of 2026-11-10 found

An audit of what production had published, on 10 November 2026, and what
changed for each finding. The evidence is quoted so the rules can be traced
back to it.

| Found in production | What changed |
| --- | --- |
| One pass, no revision; audit findings stored and never acted on | One revision after the audit, with the findings named ("The revision") |
| Openings "The landscape of content creation is rapidly evolving… no longer a luxury but a strategic necessity", "In today's competitive digital landscape…"; closings "GetTrafficFast offers an unparalleled solution" | Banned in the outline and writer prompts with these examples; `STOCK_PHRASE` |
| Titles "Mastering…" ×5, "Unlock…", "Blueprint" ×4, "Definitive Guide" ×2, up to 118 characters; "…Ranked by SEO Performance & Revenue Outcomes" over a body that ranks nothing | Title rules in both prompts; `TITLE_STYLE`, `TITLE_UNDELIVERED` |
| The "quality" writer ran on gemini-2.5-flash for most articles (audit scores 45–60, against 72–78 for the ones Claude Sonnet wrote) | The writer keeps its tier and the model is recorded (docs/AGENT_RUNTIME.md, "The writer stays on a quality model") |
| The audit read `bodyText.slice(0, 12000)` and reported "the article text is truncated" as critical on complete articles | The audit reads the whole body and is told it is complete |
| Research failed on 13 runs and the outline planned from model priors | Research is retried once, then the article is held (docs/INTELLIGENCE.md) |
| Links to a lookalike of the site's own domain (another ending, or a `www.` brand domain), not the real `website_url` | The writer is given the real `website_url` as the only address; `LOOKALIKE_LINK` |
| Invented ratings ("a subjective rating of 4.2 out of 5 stars"), invented competitor prices, "typically requires 50–200+ published articles" | Facts and evidence are the only sources of figures in the prompts; `UNSUPPORTED_NUMBER` |
| 40 headings in 1,662 words; the FAQ usually one question | H3 only for a 150-word subsection, 5–8 H2s, FAQ of 3–5 or none (the outline drops a shorter one); `HEADING_BLOAT`, `THIN_FAQ` |
| The writer prompt forbade `<table>`, `<pre>` and `<code>`, which the sanitizer allows; tutorials had no code and comparisons no tables | All three allowed; a comparison table is asked for on comparative keywords, code blocks on technical how-tos |
| The product named in the intro, the mid-body and the conclusion | At most once, in the closing section, one plain sentence; `PRODUCT_MENTION` |
| Target 900–1500 words, real output up to 3,643, 22 of 36 articles over 1,500 | The prompts say the range is a ceiling; `ARTICLE_TOO_LONG` over 1,800 |
| "content calendar generator": 8 of 8 results free tools, labelled transactional, a 2,442-word guide published anyway | The intent gate skips the article (docs/INTELLIGENCE.md) |
| Real numbers in `businesses.voice_settings.aboutYou`, used by no article | Passed to the outline, the writer and the revision as the only first-hand facts (docs/VOICE.md). Replaced on 2026-11-12 by Facts for articles (`articleFacts`): About you is for replies, and its weak early numbers are kept off the blog |
| The audit's `metaTitle` stored and unused | `metaTitle` is a field of the Canonical Article |

Not changed here: articles already published are not rewritten or
re-checked; that takes a Regenerate from the calendar, one article at a
time.

### Comparison pages (2026-11-15)

A topic whose intent is `comparison` (`keywords.intent`, docs/
INTELLIGENCE.md, "Search intent of a topic") is a page where the reader is
choosing between tools, and "the product at most once, in the closing
section" would make it dishonest by omission: the business is one of the
options. `loadContext` reads the keyword's intent with the keyword (the
rules' verdict for a row from before), and the brief carries it
(`BusinessFacts.topicIntent`, `lib/agents/article-brief.ts`) to the writer
and the revision:

- `comparisonBlock`: compare the real options the keyword or the search
  evidence names, never another; each fairly, strengths and limits from the
  evidence; say plainly who should choose a competitor over the business;
  the business is one option, never first or the winner by default,
  described only with the business context and Facts for articles; a price
  only when the evidence states it, otherwise "check their pricing page";
  no scores or ratings;
- `comparisonProductRule` replaces the closing-sentence rule (the writer's
  "The product" and the revision's `productRule`): its own table row and
  short section like every other option, not in the introduction, no
  superlative, no claim the facts do not make;
- the comparison table is asked for, as for a comparative keyword;
- the gate (`productMentionProblems`, `GateContext.comparison`) reads the
  business as one option there: still flagged in the introduction, with a
  superlative, or in more than `COMPARISON_MENTIONS` (6) sentences; the
  table's cells (a "Best for" column) are not read as a boast. Every other
  intent keeps the old rule exactly, and the numbers gate is unchanged: an
  invented price is still `UNSUPPORTED_NUMBER`.

`resettle_article` does not read the intent: `PRODUCT_MENTION` is a warning
that drives the revision, never a reason to hold, so its re-check is
unaffected. Tests: `tests/agents/comparison-brief.test.ts`.

## What may hold an article (2026-11-12)

The case: on 12 November 2026 "AI SEO Content Writer: A Workflow From
Draft to Clicks" was held in `needs_review`. Its only critical finding was
an E-E-A-T opinion of the audit: "The article's central figures (9 to 342
weekly impressions, 0 clicks, positions 30 to 40) are presented without a
Search Console export, date range or source, so readers cannot verify
them." Those were the site owner's own figures, which the writer had been
told to use; the audit did not know, and no revision could fix it without
inventing a source. The revision made it worse (a lower score, a new
`PRODUCT_MENTION` warning, still one critical) and was kept anyway, and the
calendar said "these quality checks failed, so it was not sent to your
site:" over an empty list. The requirement: an article is never held for a
reason that is not a real problem. (The figures quoted here are the
fictional ones of the test fixture.)

**What may send an article to `needs_review`**, one place,
`lib/content/quality/blocking.ts`:

- the deterministic gates that are review grade: `UNSUPPORTED_NUMBER`,
  `PRIVATE_FACT`, `LOOKALIKE_LINK`, and the structural ones that say the
  document itself is off (leaked prompt, Markdown residue, a missing
  excerpt, a soft-short article…);
- an audit finding that is `critical` AND whose `category` is in
  `BLOCKING_AUDIT_CATEGORIES`: `invented_fact` (a fact or number in neither
  the evidence nor Facts for articles), `wrong_link` (wrong or broken),
  `factual_error` (against the research evidence or the owner's facts),
  `unsafe`.

Every other critical (E-E-A-T opinions, structure, intent, chunking: the
`editorial` category) drives the revision like a warning and is stored, but
never holds the article. Why: those are judgements of taste a model makes
differently each time, and a revision cannot always satisfy them (it cannot
produce a Search Console export); the four that block are checkable against
something outside the model, and a reader would be misled or harmed by
them. Each finding is stored with its `category` in
`quality_report.aeo.findings`; a finding stored before this day has none and
reads as `editorial`.

**The author's own figures.** The audit (version 4) is given the owner's
Facts for articles as the author's verified first-hand data, the site's
address and the research evidence, and is told a figure from the facts is
never an E-E-A-T problem. In code, whatever the model said
(`clearFirstHandFindings`): a critical or warning `invented_fact` or
`editorial` finding whose figures (years and 0 aside) are all in Facts for
articles becomes `info`, category `first_hand`, with the suggestion to state
the period in the sentence ("in my own Search Console, Sep–Nov 2026"). The
writer is told to attribute such a figure in-line with its period from the
owner's wording. Since the same day an article reads Facts for articles,
never About you (docs/VOICE.md): the figures of this case are About you's,
so in an article they are now `PRIVATE_FACT`, held and sent to the revision
to be removed.

**A revision is kept only if it is better** (`chooseDraft`): fewer blocking
problems first, then fewer critical findings, then fewer gate issues, then
a higher audit score; the first measure that differs decides, a tie keeps
the original, an unknown score counts for neither. `quality_report.revision`
records `kept` ("original" or "revision") and `reason`, with `before` and
`after` (now with `blocking`). The revision prompt (version 3) also says the
rewrite must not add product mentions: at most one, in the closing section.

**The hold message lists the reasons.** The modal read
`quality_report.issues` with `action !== "warn"`: the deterministic gates
only. An article held by an audit finding has its reason in `last_error`
and `quality_report.aeo.findings`, never in `issues`, so the list was empty.
`settle` now writes `quality_report.blocking` (`{ source, code, message }`),
and the card, the modal and `publish_article`'s `issues` all read
`holdReasons` (`lib/content/hold-reasons.ts`): `blocking`, else `last_error`
split on " | ", else the review-grade issues. With none of them, the modal
says "The reason was not recorded." instead of an empty list. Regenerate and
Publish anyway are where they were. `get_content` reads the same function:
a held article reads "Waiting for you:" and its first reason, never an
empty one (`contentArticle`, `lib/calendar/content-plan.ts`).

**Re-checking a held article without spending**: `resettle_article` (write
scope, free, `lib/articles/resettle.ts`) re-runs only the deterministic gates
on the stored canonical document (with Facts for articles, About you and the
research the production job stored in `job_steps`) and the blocking decision
on the stored audit findings, with no model call. It publishes nothing: an
article with no reason left becomes `generated` (the lifecycle allows
`needs_review → generated` for this) and the publishing tick delivers it on
its date; one still held stays `needs_review` with `blocking` and
`last_error` brought up to date and the old reasons kept under
`quality_report.resettled`. The article of this case states About you's
figures, so re-settled it stays held, for `PRIVATE_FACT`, correctly: it needs
a Regenerate (one paid run) to be written from Facts for articles.

Tests: `tests/content/blocking.test.ts` (the allowlist, the first-hand
clearing, the choice of draft and the hold reasons against the stored row of
this case, `tests/fixtures/held-article-2026-11-12.ts`),
`tests/jobs/produce-article-revision.test.ts` ("the article held on
2026-11-12"), `tests/tools/resettle-article.test.ts`,
`tests/dashboard/article-card.test.tsx` ("Held before publishing: the
reasons").

## The provider rotation (2026-11-10)

Decided by the owner on 10 November 2026. Until then the writer and the
revision ran on Claude first (`LLM_WRITER_PROVIDER=anthropic`) and every
other article agent on Gemini, a split chosen from one audit and never
compared. With `LLM_ARTICLE_ROTATION=gemini,anthropic` the article agents
alternate between the two providers by UTC day, all of them together, so
that after some weeks there is data to decide, task by task, which
provider keeps which task. How the arm is chosen, stored and honoured is
docs/AGENT_RUNTIME.md, "The article rotation".

What is compared, by `compare_article_providers` and
`GET /api/articles/provider-comparison`
(`lib/content/provider-comparison.ts`, pure; read by
`lib/articles/provider-comparison.ts`), per site and over the last 90 days
by default:

- **Per agent and per provider**, over the jobs whose arm was that
  provider: `samples` (completed runs every call of which the arm's own
  provider answered), cost per run and duration per run. A run the other
  provider answered is counted in `fallbackRuns` and left out of every
  average, because it measures the other provider; a day on which the
  arm's account refused for billing is visible there, not hidden. Failed
  runs (`failedRuns`), runs with no record of who answered
  (`unattributedRuns`) and runs where the provider stepped down its own
  model chain (`steppedDownRuns`, still its own) are counted too.
- **Per arm, the articles**: how many production jobs ended, the share
  where something was found to revise, the share that ended
  `needs_review`, the share skipped by the intent gate or failed, the
  average count of deterministic gate issues on the first draft, the
  average word count, and the audit score.
- **Per arm, downstream**: Search Console's impressions, clicks and
  impression-weighted position over the first 28 days after the first
  successful delivery, only for articles whose 28 days are fully ingested
  (`measuredArticles`). An article still inside its window, or not
  ingested that far, is `waitingArticles`; one regenerated after it was
  published, or refreshed inside the window, is `excludedArticles`,
  because the page is then not the arm's draft. An article measured and
  never shown counts as 0 impressions; with nothing measured the figures
  are null.

What the numbers can and cannot say:

- **The audit score is not a neutral measure.** The audit is one of the
  article agents, so on a given day the provider that wrote the article
  also scored it. The output says so in a field
  (`auditJudgedBySameProvider: true`), and a score the fallback gave is
  left out of the arm's average. A provider that is lenient with itself
  would look better here and be no better. `neededRevisionRate` and
  `needsReviewRate` inherit part of this: the audit's findings feed both.
- **The neutral yardstick is `avgGateIssuesBeforeRevision`**: the
  editorial gates are code, they run the same way on both arms, and they
  read the first draft before any model has judged it.
- **Search traffic is slow and confounded.** It arrives 28 days after
  publication, and the keyword, the day and the site differ between the
  articles of the two arms. It is reported, not attributed.
- **Rates with no samples are null, never 0**, and with fewer than 10
  articles on an arm the output carries `enoughSamples: false` (per arm,
  per agent under 10 runs, and for the whole answer unless two arms have
  10 each).
- **No winner is declared anywhere.** The tool reports; the owner decides,
  task by task, and the decision is then a change of configuration.
- Cost per run (`avgCostUsd`) comes from the vendors' published prices
  (`lib/providers/llm/`), an estimate and not billing truth. It is the
  platform's cost, so only a platform owner reads it, on the route, on
  the platform's own site (`isPlatformOwnerHere`); the tool and everyone else get the comparison
  without it (`withoutCosts`, owner's decision of 2026-11-14).

Tests: `tests/content/provider-comparison.test.ts` (nulls, the fallback
left out, `enoughSamples`, the 28-day rule),
`tests/tools/read-provider-comparison.test.ts` (the read, per site).

## Known gap

`lib/markdown.ts` (`htmlToMarkdown`, used only by the "Copy Markdown" button in
the article modal) is still a hand-rolled converter. It is outside the
publishing path — nothing a customer receives goes through it — but it should be
replaced with a real serialiser (e.g. `turndown`) when that button matters.
