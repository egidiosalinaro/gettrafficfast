# Knowledge layer

Phase 3 of `docs/ARCHITECTURE.md`. The knowledge graph is what turns a pile of
articles into topical authority: on every generation the platform records what
the article is about (entities, topics) and uses what it already knows to place
real internal links. It compounds — every article makes the next one better.

## What exists

```
lib/agents/knowledge-extract.ts   names the entities and topics of an article
lib/agents/internal-links.ts      picks anchor text for related published articles
lib/knowledge/repository.ts       the only writer of the graph (upserts, queries)
lib/knowledge/linking.ts          pure: verifies anchors and wraps them in <a>
lib/knowledge/backlinks.ts        pure: which older articles get a link to a new one, and the link
lib/knowledge/read-next.ts        pure: which published articles the Read next block lists
lib/knowledge/push-links.ts       pure: Push page 3's one link from a best page (docs/LIFECYCLE.md)
lib/jobs/workflows/backlink-article.ts   the back-link pass as a job
```

Migration: `supabase/migrations/20260805100000_knowledge_graph.sql`.

## Data model

Keyed by `user_id`, like the rest of the schema (businesses are one-per-user).

| table | what a row is |
|---|---|
| `entities` | a named thing the site's content covers — unique on `(user_id, type, canonical_name)`; `canonical_name` is the lowercased dedup key, `name` keeps the display form |
| `article_entities` | "this article covers this entity", with `role` (`primary`/`mentioned`) and `salience` 0–1 |
| `topics` | a cluster — unique on `(user_id, slug)`; `parent_id` and `pillar_article_id` are reserved for cluster planning |
| `article_topics` | cluster membership; exactly one row per article has `is_primary` |
| `article_links` | an internal link the platform placed — `(from, to, anchor)` unique, `status` in `suggested`/`applied`/`removed` |

RLS matches the platform convention: owners can `select`, only the service role
writes.

## The knowledge step

`produce-article` gained a final, **best-effort** step after `enrich`:

1. **Extract** — the knowledge-extract agent reads the canonical article and
   returns entities (name, type, role, salience) and 1–3 topics with exactly
   one primary. Model-facing schema has no maximums or closed enums with
   consequences: unknown types degrade to `other`, unknown roles to
   `mentioned`, salience is clamped, counts are capped by code (the standing
   rule: minimums are the model's job, maximums are code's).
2. **Persist** — the repository upserts on natural keys, so re-runs and
   articles naming the same thing converge on one graph node.
3. **Relate** — `findRelatedArticles` walks shared entities/topics and keeps
   only articles that are **live** (`published_url` set): an internal link must
   point somewhere a reader can actually go. Ranked by overlap; the step
   reads up to 10.
4. **Suggest** — the internal-links agent (version 2) sees the new article's
   text and the related targets, and returns at most 8 anchors (3 until
   2026-11-15), asked to aim for as many as genuinely fit and to spread them.
   The anchor must be an exact verbatim span of the article text; the agent
   is told the system verifies it. One call, whatever the cap.
5. **Apply** — `applyInternalLinks` trusts nothing. A link is applied only when
   the anchor exists **verbatim, exactly once, inside a single text node** of a
   linkable region (never inside headings, existing links, code, or figures).
   Everything else is dropped with a reason in the step output. Applied links
   update `canonical`/`content` and are recorded in `article_links`.
6. **Read next** — code, no model: up to three related live articles are
   appended as the article's last section (below). Stored with the links,
   in one write, and recorded in `article_links` with the title as anchor.

A failure anywhere in this step never fails the job — the article is already
valid; losing knowledge loses graph rows, never content.

## Why linking is this strict

The linking module is the only code allowed to modify an article for a link,
and it operates on the parsed tree, never the source string ("detectors may use
patterns; fixers may not"). Matching happens on the raw text of a node — the
same tag-stripped form the agent saw (`linkableBodyText`) — so a verbatim copy
round-trips exactly. Consequences, all intentional:

- an anchor the model invented → dropped ("not found verbatim");
- an anchor that appears twice → dropped ("ambiguous") rather than guessed;
- an anchor spanning `<strong>`/`<em>` boundaries → dropped (not one text node);
- a target already linked in the document → skipped (idempotent re-runs).

Losing a link beats corrupting an article, in exactly the way losing a
publication beats publishing corrupted content.

## Read next (2026-11-15)

Part of the article's anatomy (docs/CONTENT_PIPELINE.md): every article
ends with a block of up to three related articles of the same site, so
that with the in-body links an article on a site with enough published
articles has 6 to 12 internal links.

```html
<h2 id="read-next">Read next</h2>
<ul><li><a href="https://site/blog/a">Title of A</a></li>…</ul>
```

- **Which** (`pickReadNext`, lib/knowledge/read-next.ts): related through
  the graph, closest first, and not already linked in the body; then, only
  when the graph relates fewer than three, the site's other live articles
  (`listLiveArticles`, title and keyword out of the canonical document)
  whose keyword and title share words with this one (the near-duplicate
  rule's tokens, lib/keywords/duplicates.ts, Jaccard ≥ 0.15), most similar
  first; then related articles the body already links to. Never the
  article itself, never one page twice, and never an unrelated article to
  fill the block: fewer than three, or no block, is a normal outcome.
- **Only live pages, only real addresses.** Every candidate has
  `published_url`, the address the destination answered a successful
  delivery with; it is written as it is, escaped, and only when it is http(s)
  (`withReadNext`). No URL is built.
- **The block** (`withReadNext`, lib/content/anatomy.ts) is written on the
  document: an `<h2 id="read-next">` labelled in the site's language ("Leggi
  anche", "Sigue leyendo", "À lire ensuite", "Weiterlesen") and a list,
  appended to `bodyHtml` and to `headings`. A block already there is
  replaced, so a retried step never writes two; with no item there is none.
- **Every destination.** It is part of `bodyHtml`: this site's blog renders
  it in a `<nav>` (docs/BLOG.md), the webhook carries it in `html` and
  `body_html`, WordPress in the post content, Copy HTML and Copy Markdown in
  the export. The editorial gates read the body without it
  (`withoutReadNext`): its titles are not the article's prose.
- **Cost**: none. No model call; at most one more read of the site's
  articles, and only when the graph relates fewer than three.
- **Not here**: a line to the site's pricing or product page. The business
  profile has no such page on record, and an address is never guessed.

## The back-link pass

The linking above only points backwards: a new article links to older ones
(0 to 3 each, and an audit on 2026-11-10 found 9 articles with none). The
older articles never linked forward, so the newest article, the one with no
history, was also the one nothing on the site linked to.

Now, when an article is published for the first time, a `backlink-article`
job is queued (`enqueueBacklinkPass`, from the generation cron's publish
loop and from `publishArticleNow`; once per article, so a republish or a
retried publish queues nothing). It never runs inside the publish, cannot
fail it, and never touches the new article.

```
select   the article is live, the site has back-links on
         → findRelatedArticles (shared entities or topics, live, same site)
         → planBacklinks: not itself, not twice, not one that already links
           to it (article_links, or an <a> in its body), at most 3
link     for each older article, read again as it is now:
         → placeBacklink: ONE link, verified by applyInternalLinks
         → archive the previous document (article_versions, "back-link to …")
         → store canonical + content, stamped dateModified
         → publishArticle with its external_post_id (the destination's update)
         → article_links: from older → to new, "applied"
```

Where the anchor comes from, in order:

1. **The keyword, found by code.** If the older article writes the new
   article's keyword verbatim (any letter case, whole words, one text node,
   a spelling the body uses exactly once), that span is the anchor
   (`findPhraseAnchor`). No model is asked.
2. **The internal-links agent, on the fast tier**, only when (1) found
   nothing: the same agent the forward linking uses, given the older
   article's text and the new article as its single target, `maxLinks: 1`.

Either way the span goes through `applyInternalLinks`, the same verifier as
every other link: it must match a single text node character for character,
outside headings, links, code and figures, or it is dropped and the older
article is left exactly as it was. An anchor the model invented changes
nothing. "No natural anchor in this article" is a normal outcome.

Bounds and refusals:

- at most **3 older articles** per new article (`MAX_BACKLINKS`, enforced
  when selecting and again when linking), **one link** in each;
- never the new article itself, never an article of another site, never one
  that is not live;
- an older article with a refresh job queued or running is skipped: the
  refresh is about to replace its document;
- a second pass for the same article changes nothing (the link is on
  record and in the body);
- if the site refuses the update, the link stays in the stored document and
  is recorded as `suggested`, not `applied`: nobody can follow it yet. The
  next delivery of that article carries it.

**What it costs.** Nothing when the keyword is found by code. Otherwise one
fast-tier call per older article, about 3,000 input tokens and 100 output:
roughly $0.004 on the dearest fast model in the price tables, $0.001 on the
cheapest; three calls at most, so about one cent per published article in
the worst case, under a ceiling of `BACKLINK_BUDGET_USD` ($0.05) for the
job, retries included (the budget is rebuilt from `agent_runs`, so a resumed
job does not start it again). Every call is in `agent_runs` like any other
and counts toward the account's daily AI spend limit. The job is registered
as LLM-bound and paid (`lib/jobs/registry.ts`): it waits out a billing
pause and runs only for an owner with an active subscription.

**The setting.** `automation_settings.backLinks`, per business, **on by
default** (a stored column without the field reads on): the cost is pennies
and the work only follows an article the owner already paid to produce and
publish. It is independent of Autopilot's `enabled`. Settings → Autopilot,
"Link older articles to new ones", or `update_automation_settings` with
`backLinks: false`, turns it off; the job then reports "back-links are off
for this site" and reads nothing else.

**What the customer's site sees.** An ordinary update of an existing post:
the same `article_id`, the body with one more `<a>`, and `date_modified`
set (payload v5, docs/NEXTJS_WEBHOOK_RECEIVER.md), so a receiver that shows
"Updated" shows it. WordPress updates the post in place through the stored
post id.

## What the graph unlocks next

In order of payoff, per the architecture: gap analysis against competitors
(Phase 4 providers), cluster planning (`topics.parent_id` +
`pillar_article_id` are already in place), and cannibalisation detection — all
of them read `article_entities`/`article_topics` and never parse HTML, because
`article_links` records what was placed.

## Tests

- `tests/knowledge/linking.test.ts` — the defensive contract of
  `applyInternalLinks` (verbatim, unique, single-node, non-linkable regions,
  idempotency, attribute escaping).
- `tests/knowledge/backlinks.test.ts` — the back-link pass's pure part: the
  cap of three, no self-link, no duplicate, the keyword found by code, and
  every way an anchor fails verification leaving the article untouched.
- `tests/jobs/backlink-article.test.ts` — the job: three updates delivered
  through the publish path with the stored post id, the version archived,
  `article_links` written, the agent asked only when the keyword is absent,
  the setting, a refused delivery recorded as `suggested`, queued once.
- `tests/knowledge/read-next.test.ts` — the choice of Read next: graph first,
  a new path before an existing link, the word-similar fallback, never itself
  or an unrelated article.
- `tests/jobs/produce-article-knowledge.test.ts` — the step: links in the
  body and the block, written once on a retry, the fallback with no model
  call, nothing changed when nothing is related, and the block in the
  HTML and Markdown exports.
- `tests/agents/knowledge-agents.test.ts` — boundary behaviour of both agents
  against the stub provider: taxonomy noise degrades, hallucinated target ids
  are discarded, counts are enforced in code.
