# Voice

How a business sounds when the platform writes in its name. A per-business
setting, read by the agents that write as a person rather than as a site.

## Why it exists

The Placements inbox proposed replies that read as an AI marketer: the
competitor acknowledgement, the pivot, the benefits paragraph, the soft
close on the brand. Part of that was the prompt (docs/PLACEMENTS.md, "Written
like a person, not a pitch"). The other part was that the business had no way
to say how it actually sounds, nor what it can truthfully say about itself,
so the model either wrote as nobody or invented a history ("I've found that
the real game-changer…"). Both are fixed here.

## The setting

`Settings → Voice` (`app/(app)/settings/voice`, titled "Voice and facts"
since 2026-11-14; `xHandle`, the site's X account, is stored here and
edited in Settings → Connections and on Today, through the `PATCH` below;
the `findPostsOnX` switch once stored here is gone since 2026-11-24 and
ignored when read), saved per business in
`businesses.voice_settings`: a jsonb parsed through defaults by
`lib/voice/settings.ts`, the same shape as `media_settings` and
`automation_settings`, so a new knob is a schema change and old rows keep
working. Migration `supabase/migrations/20260922150000_voice_settings.sql`.
API `GET`/`POST /api/business/voice-settings`: tolerant on read, strict on
write, the row always picked from what the signed-in user owns. Since
2026-11-12 also `PATCH`: only the fields sent change (the Replies page's
Today sheet sends `{ dailyReplyGoal }`), through the merge
`update_voice_settings` uses (`updateVoiceSettings`,
lib/business/save-settings.ts); a partial change over a stored value that
cannot be read is refused (409), never merged onto the defaults.

| Field | What it is | Default |
| --- | --- | --- |
| `preset` | `plain` · `casual` · `technical` · `warm`; each has one prompt line | `plain` |
| `person` | `auto` (whatever reads naturally) · `i` · `we` | `auto` |
| `aboutYou` | **How the writer uses the product, and the only personal experience a draft may claim.** True facts, in the owner's words, up to 2,000 characters (400 until 12 November 2026). Required before a placement draft is written. Never pasted into a draft: a reply names no product, and an article says it in its own words. A fact here is used only when it fits the post, and a dated one past 30 days is stated as of its date (below, 10 November 2026). | empty |
| `articleFacts` | **Facts for articles** (since 12 November 2026): "True things your articles may state about you and your business. Leave out what you would not want on your public blog." Up to 2,000 characters, optional. The only first-hand facts the article agents read; never read by a reply. Empty means an article states no results or numbers of the writer's own (below). | empty |
| `instructions` | **Your own notes**: how the owner writes, what they always and never say. Up to 600 characters. **Hard rules for the writer** since 9 November 2026 (below). | empty |

`describeVoice(settings)` turns the four into prompt lines. The empty
`aboutYou` is not omitted; it is spelled out ("Nothing is known about the
writer's own experience, so the reply claims none: no 'I've been using', no
results, no time spent"). Silence would leave the model free to invent, and
an invented experience is exactly the kind of claim the gate refuses.

**The notes are rules, not context** (`notesAsRules`). On 9 November 2026
the owner's notes opened "Lowercase, short lines, like a reply typed on a
phone… Lead with a number or a concrete thing I did", and the X reply came
back in sentence case, about the topic from above, with nothing of him in
it. The notes had been one line at the bottom of the prompt, after the
tone preset. Now the placement drafter puts them right after the business,
before the thread, as hard rules: every variant follows them, and where a
note and the preset, the example's style or the platform's usual register
disagree, the note wins. Only the rules on inventing nothing, naming no
product and carrying no link stand above them. `describeVoice(settings, {
notes: "elsewhere" })` then leaves them out of the voice lines and points
back at them, so they are paid for once.

`noteRules(instructions)` is what code can read from the notes: lowercase
only, for now ("lowercase", "lower case", "lower-case", and not a note that
refuses it, "never lowercase"). When the notes ask for it, the prompt says
so in a line of its own and the gate checks it on a short reply
(`follows_your_notes`, docs/PLACEMENTS.md): a warning the rewrite is asked
to fix, never a refusal, so a draft is not lost over capitals.

## Facts that fit, and facts that age (10 November 2026)

`aboutYou` is the list of the only first-hand facts a draft may state. That
makes a fact allowed, not apt. Example (fictional): About you holds
"Co-founded Postwren, email marketing for Shopify stores: 12 paying stores
in October 2026." and the notes say "Lead with a number". Under a post about
a hackathon judged by paying customers, a draft leading with "12 paying
stores for my own thing…" is wrong three ways: the reply is written for
another product's site, "stores" means nothing to a reader who does not know
that product, and the number may no longer be true. Two protections cover
it.

**A fact is used only when it fits the post** (`lib/voice/fact-rules.ts`,
`factFitRule`, in the draft prompt and the Fix it prompt). A fact may be
stated only when it is about the same subject as the post and a reader who
has never heard of the product behind it understands it as written. The
prompt names the site the text is written for and what it is about
(`businesses.niche`, one line; the description stays unread, since the
writer that reads the brochure writes the brochure), so the model can tell
which facts are this site's: a fact about a different product or business
stays out unless the post is about that product or its market. When no
fact fits, the text carries no number and no fact about the writer. A note
about style ("lead with a number") or an earlier correction ("use one of
my numbers") never forces an unrelated fact; `notesAsRules` now lists
"using a fact only where it fits the post" among the rules that stand
above the notes. The line that hands About you to the drafter no longer
calls it "how the writer uses the product": it says a fact there may be
about this business or about something else the writer does. The gate
checks the part code can decide (docs/PLACEMENTS.md, "A fact only where it
fits").

**A stale fact is flagged, never silently used as current**
(`lib/voice/staleness.ts`, pure, no I/O, the clock passed in).
`aboutYouFacts(aboutYou, now)` splits About you into sentences (a full
stop, a question or exclamation mark, a semicolon or a line break; a colon
keeps its halves together, because "Co-founded X, a tool for Y: 7 paying
stores" is one fact) and reads the dates in each. A sentence whose most
recent date is more than `STALE_AFTER_DAYS` (30) days before `now`, in UTC
days, is stale; exactly 30 days is not. A sentence with no date is never
flagged.

| The text says | Read as |
| --- | --- |
| `2026-10-27`, "Oct 27 2026", "October 27th, 2026", "27 October 2026" | that day |
| "October 2026", "in Oct 2026" | the month, dated by its first day |
| "late September 2026", "mid-October", "early March" | that part of the month, dated by its first day (1st, 11th, 21st) |
| "the week of Oct 26" | the week, dated by that day |
| "Oct 26", "26 October", "in October", "since late September" (no year) | the most recent past occurrence: this year's when that is today or earlier, else last year's. "Oct 26" is the 26th, not 2026: a year is four digits |

A period is dated by its first day, the oldest the fact can be: asking
"still true?" once too often costs one quiet line, and not asking is how a
stale number gets posted as current. So a fact dated "October 2026" is
asked about from 1 November. A date with no year is never read as a date
still to come, because a fact is recorded after it happened. What cannot
be read with certainty is not guessed, and so never flagged: a slashed
date ("03/04/2026" is March or April depending on who wrote it), a date
that does not exist ("Feb 30 2026"), a bare year ("since 2019" is a
lasting fact, not a reading), a month with no word that makes it a date
("may" the verb; "by December" is a goal), and anything relative ("last
month" is relative to a day nobody recorded).

On the fictional About you used in the tests, read on 10 November 2026, the
rule flags one sentence, the Postwren figure ("October 2026", last month);
the sentences dated "the week of Oct 26" and "Oct 27 2026" are asked about
from 26 and 27 November.

Where it shows:

- **Settings → Voice**, under the About you field: one quiet line per stale
  sentence, 'Dated October 2026 (last month): still true?', with the
  sentence quoted short (`StaleFactLines`). A day is counted in days ("15
  days ago"), a month in months. It is read from the text as it stands in
  the box, so it goes when the sentence is brought up to date. No modal,
  nothing blocked, and nothing ever edits the owner's text. A fact
  confirmed on Today (below) gets one small muted line instead, "confirmed
  Nov 14" with the sentence quoted short, on one line; edit the sentence in
  the box and the line goes and the question comes back, because the
  confirmation was for other words. Once its confirmation is over 30 days
  old it is asked about again: 'Dated October 2026, confirmed Nov 14, 2026
  (31 days ago): still true?'.
- **Today, "Also today"** (since 2026-11-14): one card per stale sentence,
  "Still true?", with **Still true** and **Update it** (this page). See
  "Still true" below. A card for a fact confirmed before reads ", confirmed
  32 days ago" instead of ", dated last month".
- **`GET /api/business/voice-settings` and `get_voice_settings`**: two
  additive fields, `staleFacts` (sentence, `date`, `dateLabel`,
  `precision`, `yearAssumed`, `confirmedOn`, `ageDays`, `age`, `line`) and
  `staleAfterDays`, derived on read by `loadVoiceSettings`, never stored.
  `date` and `dateLabel` are the sentence's own; `ageDays` and `age` run
  from the later of that date and `confirmedOn`.
- **The draft and Fix it prompts**: each stale sentence is passed with its
  own date and the instruction to state it as of that date, in the past
  tense ("in October I had…"), never as current, or to leave it out
  (`staleFactsRule`). The job reads them, with the confirmations; the
  agents take them as input (`staleFacts`), so the prompt stays a function
  of its input.
- **The gate**: a figure from a stale sentence stated with no word of when
  is refused (docs/PLACEMENTS.md). A fact confirmed within 30 days is not
  stale there either; once it is again, naming its own month or the month
  of the confirmation counts as saying when.

**"Still true" (Today, 2026-11-14): a confirmation, stored apart from the
text.** The first version wrote the day into the sentence ("… in October
2026 (still true on November 14, 2026).") so every reader would agree
with no new field, but the drafter reads About you, so the date leaked into
the text drafts are built from. Now:

- **The field**: `confirmedFacts` in `voice_settings`, a map from a fact's
  key to the day it was confirmed, `YYYY-MM-DD` in UTC:
  `{ "co-founded postwren: 12 paying stores in october 2026": "2026-11-14" }`.
  The key is `factKey(sentence)` (`lib/voice/staleness.ts`): the sentence
  of `factSentences` with its spacing collapsed, case and end punctuation
  ignored. Change a word, a number or a date and it is another fact,
  which nobody has confirmed. At most 200 entries (`CONFIRMED_FACTS_MAX`);
  an old row without the field reads as none. No migration: a field of the
  same jsonb.
- **Bounded to facts that exist**: every write of the voice keeps only the
  keys of sentences About you still has (`withLiveConfirmations`, in
  `saveVoiceSettings` and the About you writes of
  `lib/voice/about-you.ts`). Removing a fact (Settings, `update_voice_settings`
  or `remove_about_you_fact`) removes its confirmation; editing it drops it.
- **The rule**: `aboutYouFacts` and `staleFacts` take `{ confirmations }`;
  a dated fact's age runs from the later of its own newest date and its
  confirmation. A sentence with no date is never stale, and cannot be
  confirmed (409). Confirming again moves the day.
- **Who reads it**: only the staleness rule: Settings, Today, `get_voice_settings`,
  the stale list the draft and Fix it jobs compute, and the gate (the
  writer context carries `confirmedFacts` for `factProblems` alone). The
  drafter is handed the voice without it (`voiceForWriter`), the article
  agents read `articleFacts` only, and no prompt contains the map or a
  date from it. About you is the person's words, byte for byte.
- **Calls**: `confirmFact` and `unconfirmFact` (pure), `confirmAboutYouFact`
  in `lib/voice/about-you.ts`. Screen: `PATCH
  /api/business/voice-settings/about-you` `{ sentence }` answers `{ fact,
  confirmedOn, previousConfirmedOn, changed }`; the toast's Undo is the same
  call with `undo: { previousConfirmedOn }`, which puts that one entry back
  (removed when null) and leaves the others. The sentence must be one of
  About you's, as `staleFacts` quoted it, else 409 and nothing is written.
  API and MCP: `confirm_about_you_fact`, with the same `undo`.
- **An old suffix**: nothing parses "(still true on …)" any more. A sentence that ended so would simply be read for its dates like
  any other, "November 14, 2026" being one of them (tested).

Not done: the dot on the Voice line of a reply's ⋯ menu when a fact is
stale. It needs the inbox payload, the page, the item and the menu to
carry a new flag, which is more than the line is worth for now.

No model call anywhere in this: the staleness is arithmetic on the text
and the confirmation days.

## "It's true": a flagged sentence confirmed into About you (12 November 2026)

The case. A reply said "i know that feeling of getting so close to an
amazing opportunity, it's rough. but that new fire to go ham on your own
startups is what matters most. during the last week i'm going 100% on
marketing for both my startups too." The gate failed it: "Check failed:
Nothing invented, and your own facts only where they fit. 1 sentence(s)
with numbers not declared as claims." The sentence was true, and the person
wanted to say so in one tap, so the draft passes and later drafts may use
the fact.

What was built (`lib/voice/about-you.ts`):

- **The transform** (`factFromSentence`), deterministic, no model: the
  flagged sentence, its talk stripped from the front ("honestly", "tbh",
  "yeah", "but", "so", …) and the back ("too", "as well", "lol"), the
  pronoun "i" written "I", and "As of <Month D, YYYY>:" in front, in UTC.
  That sentence, on 12 November 2026, becomes **"As of November 12,
  2026: during the last week I'm going 100% on marketing for both my
  startups."** The person edits it before anything is saved.
- **The add** (`appendFact`): the fact goes after the existing text, which
  is kept byte for byte, separated by one space after a sentence end, by a
  line break after text that does not end one (so the two never read as
  one sentence), by nothing after whitespace. Never rewritten, never
  reordered. A fact already there is not written twice. At most 300
  characters a fact (`ABOUT_YOU_FACT_MAX`); a fact that would take About
  you past its 2,000 (400 when this was written) is refused with "About you is full; edit it in
  Settings → Voice." and the count, and nothing is cut to make room.
- **The date** is one the staleness rule reads as a day ("November 12,
  2026"), so after 30 days Settings asks "still true?" and a draft states
  it as of its date, like any other dated fact (above).
- **The undo** (`removeFact`): exactly the sentence and the separator the
  add put before it, nothing else; the text is as it was before the add.
  The screen sends `ifAboutYouIs`, so an undo is refused when About you
  has changed since ("About you has changed since this was added, …").
- **Nothing is added the person did not confirm.** The tap only opens the
  field; only the text they save is written. The agents never call it.

The gate counts a number stated in About you as declared
(`declaredByAboutYou` in `lib/placements/numeric-claims.ts`): the same
figure, as written ("40%", "2,000 customers"), anywhere in About you.
Whether it fits the post is still asked by the fact-fit check. And a
figure of speech is no number at all ("going 100% on", docs/PLACEMENTS.md,
"It's true").

Read and written strictly, like "Add to my notes": an About you that
cannot be read is refused with a sentence, never replaced with the
defaults. Screen: `POST`/`DELETE /api/business/voice-settings/about-you`.
API and MCP: `add_about_you_fact` and `remove_about_you_fact`
(docs/API.md). No migration: About you is a field of the same jsonb.

## Something new, or nothing about you (12 November 2026)

The case. About you was capped at 400 characters and held one usable
fact, a blog's early numbers. The notes said "Lead with a number or a
concrete thing I did". Five of seventeen drafts in a row used the same
range ("position 30-40"), whatever the post was about, including a post
about being called a grifter, where a ranking has nothing to say. Every one
passed every check.

Two causes, and what changed for each:

- **One usable fact.** About you now holds **2,000 characters**
  (`ABOUT_YOU_MAX`): the schema, the form's field and count ("…/2,000"),
  `update_voice_settings`, the "It's true" refusal ("…and it holds
  2,000."), the qualifier's `aboutWriter` and the agents' inputs all read
  the one constant. A jsonb field, so no migration. The hint asks for
  several kinds of true facts: numbers you measured, what you are
  building, what you feel and believe about building, your situation,
  opinions you hold. Only true things.
- **Nothing stopped a fact from being reused, or used off its subject.**
  - The drafting job and Fix it read the business's last ten replies, one
    per post (the text posted, else the drafts), and trace which About you
    sentences each used (`factsUsed` in `lib/placements/fact-fit.ts`: a
    number counting the same thing, a range like "30-40", a name like
    "Taipei", two content words side by side like "self-taught"). The
    prompt lists them: "Facts you used in your recent replies: … Do not use
    them again unless the post asks about exactly that." (`recentFactsRule`,
    `lib/voice/fact-rules.ts`). The gate's advisory check "Repeats a recent
    fact" fails a draft that uses a sentence already in two or more of them
    (docs/PLACEMENTS.md, "A fact used recently is not used again").
  - The fit rule (`factFitRule`) now says the same subject is what the post
    is about as read, not a word the two share: rankings belong under a post
    about SEO, never under one about motivation, money, burnout or being
    called a grifter. With no fitting fact the reply may share a feeling or
    a belief in first person, with no number and no event ("i build because
    i like seeing something i made get used"), take a clear position, or ask
    one sharp question. A feeling is the writer's to give; an event is a
    fact. "even at zero revenue, I feel the same joy when someone pays for
    software I built" is not allowed as it stands when About you records no
    payment. The gate refuses an invented one
    (`lib/placements/first-hand-events.ts`).
  - A note like "Lead with a number or a concrete thing I did" reads as
    "when one fits" (`FACT_NOTES_YIELD` in `lib/voice/settings.ts`, beside
    the notes in both prompts): when none fits, the note yields and the
    reply opens with the reaction, the position or the question.
  - The drafter's reading of the post ("what the poster means") decides the
    angle: a fact comes in only if it speaks to that meaning.

Tested with the real About you, the real post and the real draft
(`tests/placements/recent-facts.test.tsx`). Drafter version 22, Fix it
version 5.

## Who reads it

- `placement-draft`: the voice lines sit in the prompt beside the platform's
  tone and the approach the job dealt. The inbox links to the setting beside
  **Rewrite** (Regenerate drafts until 2026-11-09); the next generate uses it. The writer is someone
  who uses the product, never someone who makes it. A reply under a thread
  names no product and carries no link (since 5 November 2026: the 21
  replies published with one sentence naming it all read as adverts,
  docs/PLACEMENTS.md); it may draw on what `aboutYou` says the writer does,
  never on what they do it with. Only the article on the writer's own
  account names the product once, in a clause about that use written for
  the article, and never in the "I use X for that" shape, which the gate
  refuses everywhere. With `aboutYou` empty the draft is refused before the
  model is paid (`draftPrerequisite`, docs/PLACEMENTS.md): a user with
  nothing recorded has nothing honest to say. Since version 17 the notes
  are hard rules near the top (above); an X reply is told to speak from one
  concrete fact `aboutYou` records when it bears on the post, else an
  honest reaction or one short question, casually, and that admitting a
  limit is fine; and a short reply is shown up to five replies the owner
  actually posted (`lib/placements/voice-examples.ts`, docs/PLACEMENTS.md),
  with the adverts and the sentences the gate refuses left out, as the
  voice to match. A description of a voice is not a voice; what the owner
  posted is.
- `placement-qualify`: `aboutYou` as how the person who will answer uses
  the product. A thread asking which tool to use gets an angle about how
  to choose, and the reply does not say which one the writer uses either.
- `auditDraft`: `aboutYou` as the only basis an experience claim can rest
  on (below), and, since 10 November 2026, as the source a number in the
  draft is traced back to, to ask whether it fits the post and whether it
  is dated. The maker speaking is refused whatever is recorded.
  `instructions` for `follows_your_notes`: lowercase on a short reply, when
  the notes ask for it. The draft job, the edit route and the own reply
  pass the same notes, so an edit is judged as the draft was.
- `draft-correct` (since 9 November 2026): `aboutYou` and `instructions`
  when the owner fixes a draft with a note (since version 2, 10 November
  2026, with the fit rule and the stale sentences, above; since version 3
  the note is an instruction to the writer in any language, never content
  to answer, and the reply keeps the post's language whatever the note's:
  docs/PLACEMENTS.md, "the post is read before the reply is written"); and a note he wants for good
  is appended to `instructions` as one line (`promoteToNotes`, refused past
  600 characters), docs/PLACEMENTS.md "Corrections".

- the article `outline`, `writing`, `article-revision` and `aeo-audit`
  agents (the audit since 12 November 2026, as the author's verified
  first-hand data, docs/CONTENT_PIPELINE.md "What may hold an article"): since 12 November 2026 `articleFacts` (Facts for articles) as
  "the ONLY first-hand facts and numbers you may state", never `aboutYou`
  (from 10 to 12 November 2026 it was `aboutYou`); and `instructions` as
  the owner's notes. `articleFacts` and the research
  evidence are what the numbers gate accepts a figure from; `aboutYou` is
  read by code only, by the `PRIVATE_FACT` gate, and no article prompt
  contains it (docs/CONTENT_PIPELINE.md, "Editorial gates"). The tone
  preset and the person are not read: an article is written as the site,
  not as a person.

## Facts for articles, apart from About you (12 November 2026)

The rule: true facts are fine, but a public article (and the site) need
not advertise weak early results. "From 9 to 342 impressions, 0 clicks,
position 30-40" can be honest in a reply and still be bad publicity on a
product's blog. Articles say only true things, and may leave out weak
results; replies stay candid.

Before this, About you held a blog's early numbers, the article agents were
told those were the only first-hand facts, an article stated them, and the
audit held it because the figures had no source.

What is true since:

- **Two fields.** `aboutYou` is what a reply may say; `articleFacts` is
  what a public article may say. The site's owner fills the second with what
  they are happy to see on the blog. Same limit (2,000 characters), same partial
  `PATCH` path, the same tools (`get_voice_settings`,
  `update_voice_settings`). A jsonb field: no migration; an old row reads
  it as empty.
- **Articles never receive `aboutYou`.** `loadContext` in
  `produce-article` hands the outline, the writer, the revision and the
  audit `articleFacts` as `firstHandFacts`. A figure from them is
  attributed in the same sentence with its source and period, from the
  person's wording ("in my own Search Console, between September and
  November 2026").
- **Empty means none.** With `articleFacts` empty an article states no
  first-hand numbers or results at all: it writes from the research
  evidence and general expertise, in the first person only for method and
  opinion ("the way I check a draft is…"), never results.
- **A weak number that slips in is held.** The gates are given `aboutYou`
  as `privateFacts` (code, never a model): a figure of 10 or more that is in
  About you and in neither Facts for articles nor the research is
  `PRIVATE_FACT`, a review-grade issue the revision is told to remove
  (docs/CONTENT_PIPELINE.md).
- **Replies are unchanged**: `describeVoice`, the drafter, the audit of a
  draft and Fix it read `aboutYou` exactly as before.
- **The public pages never read the voice settings**: a test
  (`tests/landing/no-voice-facts.test.ts`) fails if the landing or pricing
  sources import `lib/voice` or read `voice_settings`.

**"From our data" (15 November 2026).** An article may now carry a short
section of the site's own measurements, with a `Dataset` in its JSON-LD,
and only from Facts for articles. A fact that reads as the site's own
early traction (a count of customers, sites, visits or impressions under
1,000, a revenue under 10,000, a traction percentage or a zero, with no
verb of a study) never goes into it, even though the owner listed it; the
rule and its examples are in docs/CONTENT_PIPELINE.md, "The article's
anatomy".

Tests: `tests/jobs/produce-article-revision.test.ts` ("Facts for articles,
never About you"), `tests/content/editorial-gates.test.ts` ("figures from
About you"), `tests/voice/settings.test.ts`,
`tests/tools/write-voice-integrations.test.ts`,
`tests/settings/voice-settings-form.test.tsx`.

## Rules

- **Nothing about the writer is assumed.** With `aboutYou` empty, a draft
  that says "we've seen", "I've been using", "for us" or "in my experience"
  is an invention and the audit's claims check blocks it, naming the phrase
  and this setting; and no draft is written at all until this is filled
  (the article's one clause naming the product is itself a use claim). The same
  check runs on every edit in the inbox, with the same `aboutYou`, so what
  is copied is what was audited. An opinion ("I think") is not an
  experience and is never blocked for this.
- **The writer uses the product and never speaks as its maker.** "I work
  on X", "we built X", "founder of", "our product", "full disclosure" are
  refused by the gate whatever this setting says. Write `aboutYou` as a
  user would say it: "I publish my own site's blog through X", not "I
  built X". That is a fact for the model, not a line for a reply: pasted
  into one, it is the sentence the gate refuses.
- **The voice shapes, it does not sell.** A preset is how a person talks; the
  structures and words a promotional text falls into stay forbidden whatever
  the preset says, and the gate's person check runs on every draft.
- **Per business.** Two sites owned by one account can sound different; the
  setting follows the selected business like every other setting.
