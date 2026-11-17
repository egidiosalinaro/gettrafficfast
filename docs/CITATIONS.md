# Citation probing

Phase 5 of `docs/ARCHITECTURE.md`, second slice. Rank measurement answers
"where does this article sit on Google". This answers the other half, the one
the product actually differentiates on: **does an answer engine cite the
customer when someone asks the question the article answers?**

Until this existed, AEO was the only claim in the product with no measurement
behind it.

## The honest limit, first

No answer engine exposes "was I cited" as an API. There is no ground truth to
read, so the implementable approximation is **sampling**: ask the question
ourselves, on a schedule, of engines that return their sources, and record what
came back.

That has consequences which are baked into the design and must survive into the
customer-facing UI:

- A single probe is close to noise. Answer engines are not deterministic: the
  same question can return different sources minutes apart. Only the rate over
  many probes carries signal.
- **A rate with no probes is `null`, never `0`.** Zero reads as "we are never
  cited"; null reads as "we have not looked yet". `citationRate` returns null
  for an empty series precisely so a dashboard cannot accidentally show the
  wrong one.
- Rates are computed **per engine**. Perplexity and a search-grounded model
  disagree, and averaging them produces a number that describes nothing.
- **Under 10 probes on an engine, a rate is shown as a count, not a percent.**
  "0%" over three probes reads like a verdict and is mostly noise, so below
  `MIN_PROBES_FOR_PERCENT` (10, `lib/format.ts`) the screens print "0 of 3"
  (cited of probes), and from 10 up the percent with its count beside it,
  "20% (2/10)". The threshold is per engine and on the rate's own
  denominator; it changes what is shown, not what is stored or what the API
  returns (a rate and its counts, as numbers). A non-zero rate never reads
  "0%" ("<1%"), and one short of every probe never reads "100%" (">99%").
  `formatRate` is the one formatter: Growth's AI block and By article, the
  Overview's Measure stage, and the AI Visibility screens
  (`docs/AI_VISIBILITY.md`).

This must be presented to customers as a sampled indicator. Selling it as an
exact measurement would be selling an invented number.

## What exists

```
lib/providers/citations/types.ts       the boundary: a question in, sources out
lib/providers/citations/perplexity.ts  first engine (pure parser + client)
lib/providers/citations/registry.ts    every configured engine, or none
lib/lifecycle/citations.ts             matching (pure) + persistence + rate
app/api/cron/probe-citations/route.ts  weekly sweep
```

Migration: `supabase/migrations/20260828100000_ai_citations.sql`.

## The measurement

The sweep asks each engine the article's target keyword, then looks for the
customer's site among the sources returned.

Matching mirrors rank matching, deliberately: **exact URL first, then domain.**
If the engine cites the article itself that is an exact citation; if it cites
another page on the same site, the engine still considers that site an
authority on the topic, which is the thing being measured. Both are recorded,
and `exact` keeps them distinguishable, because "our article was cited" and
"our site was cited" are two different wins.

**Negative probes are stored.** "We asked and were not cited" is the
measurement; a missing row would read as "we never asked", and a month later
the two would be indistinguishable when the rate is computed. Same rule that
stores a null rank position in `content_metrics`.

The probe deliberately does not name the brand in the prompt. A probe that
mentions the customer steers the engine into citing them, and would measure the
prompt rather than the content.

## Engines

The registry returns a **list**, not a single provider, because `ai_citations`
is keyed by engine and one engine's rate says little on its own. Two exist:

**Gemini with Google Search grounding** (`CITATIONS_GEMINI=true`) needs no new
vendor: it reuses the key the platform already has. It is opt-in rather than
automatic precisely because the key is always present and grounded queries are
billed; a cost must never switch itself on.

It carries one trap, and the parser exists for it. A grounded response does
**not** return the source URL: `uri` is a Google redirect that resolves to the
page only when followed, and the site is carried in the chunk `title`. Reading
the domain from the redirect would make every source look like google.com, and
every customer's citation rate would sit at a flat zero with nothing in the
logs to explain it. Because grounding names the site and not the page, its
matches are domain-level: `exact` is never true for this engine.

**Perplexity** (`PERPLEXITY_API_KEY`) returns sources with titles and real
URLs, so it can produce exact matches.

Adding the next engine (an OpenAI search model, Bing Copilot) is one file in
`lib/providers/citations/` plus an env var. Nothing above the provider layer
names an engine.

## Configuration

| Where | What |
| --- | --- |
| `/api/cron/probe-citations` | weekly (Tue 09:00 UTC), `CRON_SECRET`; probes the articles of owners who pay only (`hasPaidAccess`; the others are left out of the pool before the rotation picks, and logged as `cron.unpaid_skipped`) |
| `CITATIONS_GEMINI` | `true` enables Google Search grounding on the existing Gemini key |
| `PERPLEXITY_API_KEY` | enables the Perplexity engine |
| (neither set) | the sweep reports "disabled" and records nothing |
| `PERPLEXITY_MODEL` | defaults to `sonar` — we want the sources, not the prose |

Cost is the reason the sweep is bounded: every probe is a paid call, multiplied
by the number of engines. One run covers at most 25 articles, skipping any
probed in the last 7 days, so the catalogue rotates instead of the first
articles being re-probed forever.

The sweep measures and enqueues nothing. What a falling citation rate should
*trigger* is a decision for a later slice; collecting the history is the part
that cannot be done retroactively.

## Tests

- `tests/providers/perplexity.test.ts` — the payload contract: sources are read
  from both fields the API has carried, merged without double counting,
  unusable URLs dropped. A parser that silently finds no sources is
  indistinguishable from "not cited", which is the one confusion this metric
  cannot afford.
- `tests/lifecycle/citations.test.ts` — exact vs domain matching, and the rule
  that an unmeasured article reports null rather than zero.
- `tests/format.test.tsx` ("sampled rates") — the threshold is 10, a count
  below it, a percent from it, null over nothing; `tests/results/` and
  `tests/visibility/primitives.test.tsx` — the cell and the tiles print
  "0 of 3", never "0%", under it, and no screen keeps a bare percent helper.

## Not in this slice

- Probing question-shaped queries instead of the bare target keyword. Answer
  engines are asked questions, so the FAQ headings an article already carries
  are the better probe, and they are available in the canonical document.

## One count of asks (Growth, 2026-11-14)

Growth's **AI answers** block (`/growth`, `get_growth`, docs/LIFECYCLE.md,
"Growth") answers one question per engine: in this period, how many times
was an answer engine asked, and how many of those answers cited the site?
Two families of probes exist, and the count reads **both**:

| Family | Table | What is asked | What is kept |
| --- | --- | --- | --- |
| article checks | `ai_citations` | the keyword a published article was written for, weekly (this sweep) | the verdict; the cited page and the start of the answer only when cited |
| prompt asks | `aeo_probes` | one of the questions the owner chose, in a visibility run (docs/AI_VISIBILITY.md) | status, the site's place, the start of the answer, every source verbatim |

The choice, and why. Both are the same measurement: one question put once to
one engine, and one of the site's domains looked for among the sources the
engine returned. They differ in the wording: an article check never names the
site (this sweep's rule, above), while a question the owner chose is asked as
written, and may name the business (Suggest prompts can propose up to two
that do, and the owner can type any). So the screen does not claim "without
naming you" for the block; it says the asks come from the articles' keywords
and the questions the owner chose, and the evidence page shows every
question as it was asked. Counting only the prompt asks would
show "not asked" for a site whose owner left the cadence off (the default:
it spends money) while the weekly sweep asks every week, and the block would
say less than the platform knows. Counting both is honest on three
conditions, which the code keeps:

- **per engine, never across engines.** The families are added within one
  engine (`summarizeAsks`, `lib/growth/ai.ts`); engines are never added
  together. The API also splits each engine's count by family (`byKind`), so
  a reader can tell the two apart;
- **an ask counts when it was answered.** A prompt probe with no readable
  answer (`invalid`) or a failed call (`error`) is not an answered ask: it is
  left out of the count and reported apart (`unreadable`), never as "not
  cited". The sweep stores only the answers it read, so every article check
  counts;
- **every counted ask is on the evidence page.** `/growth/ai`
  (`list_ai_answers`) lists the period's answers of both families. A prompt
  ask shows every source; an article check says what it keeps (the verdict,
  and the cited page when cited), and does not pretend to a source list it
  never stored.

A count with no ask is null, "not asked in these 7 days", never 0. Under
`MIN_PROBES_FOR_PERCENT` asks it is a count ("0 of 9 asks cited you"), from
10 a percent with its count beside it. The two families match the site
slightly differently (an article check looks for the article's own domain,
a prompt ask for any of the site's domains, subdomains included); for a site
on one domain they are the same test.

Not yet: the article sweep keeps no source list for an answer that did not
cite the site, so its "not cited" can be read but not checked source by
source. Keeping the sources (a column on `ai_citations`) is the next step if
the owner wants every counted ask verifiable.

## Since then

- The article-level rate is surfaced on Growth's By article (Results until
  2026-11-14), one line per engine in each article's row (or card, on a
  phone), as a count under 10 probes, and every article check of the period
  is an answer on Growth → AI answers.
- The business-level, customer-configured measurement — an explicit query set,
  runs, per-engine rates, competitors and sources — is **AI Visibility**
  (`docs/AI_VISIBILITY.md`). It uses the same providers and the same matching
  primitives; `CitationAnswer` grew optional `model` and `costUsd` (an
  estimate) and `CitationProviderError` carries the HTTP status and
  `Retry-After` so a run can tell a rate limit from a bug.
