-- Citation Index: a public, standing measurement of which companies answer
-- engines actually cite.
--
-- Deliberately separate from ai_citations. That table measures ONE customer's
-- article against the question it answers, and its rows are private to that
-- customer. These tables measure MANY companies against one shared question,
-- and their rows are published. Same providers underneath, different subject,
-- different audience, different access rules — merging them would tangle a
-- private metric with a public one.
--
-- The shape follows the economics: a probe is billed per question, not per
-- company, so `study_probes` holds the answer once and `study_verdicts` fans
-- it out across every company in that category. Cost scales with categories,
-- not with sample size.

-- ── Editions ────────────────────────────────────────────────────────────────
-- The index is republished over time on different samples. An edition is one
-- such run, with its own title, so the permanent name survives the topical
-- one: "Citation Index" is the product, "The Outbid Edition" is an issue.

create table if not exists public.study_editions (
  slug text primary key,
  title text not null,
  -- What this edition is asking and why, shown above the table.
  summary text,
  -- Null until published: an edition being measured is not yet an edition
  -- anyone should read.
  published_on date,
  created_at timestamptz not null default timezone('utc', now())
);

-- ── Categories ──────────────────────────────────────────────────────────────
-- The unit a probe is bought for. Every company belongs to exactly one, and
-- the whole cost model rests on that: one question per category, its sources
-- read as evidence about all of them.

create table if not exists public.study_categories (
  slug text primary key,
  -- How a person would name it out loud; it goes into the question verbatim.
  label text not null,
  -- A well-known incumbent for the comparative question. Nullable on purpose:
  -- a category with no obvious leader gets discovery only, which is honest,
  -- rather than a rival we invented.
  leader text,
  created_at timestamptz not null default timezone('utc', now())
);

-- ── Companies ───────────────────────────────────────────────────────────────

create table if not exists public.study_companies (
  id uuid primary key default gen_random_uuid(),
  edition text not null references public.study_editions(slug) on delete cascade,
  -- Lowercased host without "www." — the identity used across the platform.
  domain text not null,
  name text not null,
  -- Other spellings an engine might use. Matched like the name, and subject to
  -- the same ambiguity rule.
  aliases text[] not null default '{}',
  category text references public.study_categories(slug),
  -- 'test'  = listed on a pay-to-rank board
  -- 'control' = comparable company that is not
  -- Nullable while a candidate waits to be reviewed: an uncategorised row is
  -- not yet part of the study and must never be counted in a published rate.
  cohort text check (cohort in ('test', 'control')),
  -- Provenance, for the test cohort: which board, and what was paid to sit on
  -- it. The amount is what makes "did the money buy anything" answerable.
  source_board text,
  bid_usd numeric,
  -- 'candidate' until a human or an agent has assigned name and category;
  -- only 'included' rows are measured and published.
  status text not null default 'candidate'
    check (status in ('candidate', 'included', 'excluded')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (edition, domain)
);

create index if not exists study_companies_edition_idx
  on public.study_companies (edition, status);
create index if not exists study_companies_category_idx
  on public.study_companies (category, cohort);

-- ── Probes ──────────────────────────────────────────────────────────────────
-- One question, asked of one engine, once. The unit of billing and the unit of
-- evidence: every verdict traces back to a row here, and the raw sources are
-- kept so a surprising verdict can be audited instead of argued about.

create table if not exists public.study_probes (
  id uuid primary key default gen_random_uuid(),
  edition text not null references public.study_editions(slug) on delete cascade,
  category text not null references public.study_categories(slug),
  shape text not null check (shape in ('discovery', 'comparative')),
  -- The question verbatim: a probe is only meaningful alongside the wording
  -- that produced it.
  query text not null,
  engine text not null,
  -- Which repetition this is. Engines are not deterministic, so a verdict is a
  -- rate over runs, never a yes or a no from a single call.
  run int not null,
  answer text,
  -- The sources the engine returned, verbatim, as [{url, domain, title}].
  sources jsonb not null default '[]'::jsonb,
  checked_on date not null default (timezone('utc', now()))::date,
  created_at timestamptz not null default timezone('utc', now()),
  unique (edition, category, shape, engine, run, checked_on)
);

create index if not exists study_probes_edition_idx
  on public.study_probes (edition, checked_on desc);

-- ── Verdicts ────────────────────────────────────────────────────────────────
-- The fan-out: one probe, one row per company in that category.
--
-- Negative verdicts are stored, never skipped. "We asked and this company was
-- not cited" is the measurement; a missing row would read as "we never asked",
-- and a month later the two would be indistinguishable when the rate is
-- computed. Same rule as ai_citations and as a null rank in content_metrics.

create table if not exists public.study_verdicts (
  id uuid primary key default gen_random_uuid(),
  probe_id uuid not null references public.study_probes(id) on delete cascade,
  company_id uuid not null references public.study_companies(id) on delete cascade,
  -- The headline measurement: the engine returned this company's site among
  -- its sources. Unambiguous — a domain is in the list or it is not.
  cited boolean not null,
  -- Where it ranked among the sources, 1-based. First and seventh are not the
  -- same result and the study does not flatten them.
  position int,
  source_url text,
  -- The name appeared in the answer's prose. Weaker than a citation, reported
  -- beside it and never merged into it.
  mentioned boolean not null default false,
  -- The name matched but the domain did not, and the name is an ordinary word.
  -- Recorded rather than resolved: the headline number counts citations only,
  -- so ambiguity can never move it.
  ambiguous boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  unique (probe_id, company_id)
);

create index if not exists study_verdicts_company_idx
  on public.study_verdicts (company_id);

-- ── RLS: the world reads, the platform writes ───────────────────────────────
-- This is the deliberate difference from ai_citations, which is owner-scoped.
-- The Citation Index is published: its credibility depends on anyone being
-- able to read the same rows the report is computed from. Only rows that are
-- part of the study are exposed; unreviewed candidates stay internal.

alter table public.study_editions enable row level security;
alter table public.study_categories enable row level security;
alter table public.study_companies enable row level security;
alter table public.study_probes enable row level security;
alter table public.study_verdicts enable row level security;

create policy "Published editions are public"
  on public.study_editions for select to anon, authenticated
  using (published_on is not null);

create policy "Categories are public"
  on public.study_categories for select to anon, authenticated using (true);

create policy "Included companies are public"
  on public.study_companies for select to anon, authenticated
  using (status = 'included');

create policy "Probes are public"
  on public.study_probes for select to anon, authenticated using (true);

create policy "Verdicts are public"
  on public.study_verdicts for select to anon, authenticated using (true);

create policy "Service role manages study editions"
  on public.study_editions for all to service_role using (true) with check (true);
create policy "Service role manages study categories"
  on public.study_categories for all to service_role using (true) with check (true);
create policy "Service role manages study companies"
  on public.study_companies for all to service_role using (true) with check (true);
create policy "Service role manages study probes"
  on public.study_probes for all to service_role using (true) with check (true);
create policy "Service role manages study verdicts"
  on public.study_verdicts for all to service_role using (true) with check (true);

-- ── The first edition ───────────────────────────────────────────────────────
-- Seeded unpublished: it becomes readable when there is something measured to
-- read.

insert into public.study_editions (slug, title, summary)
values (
  'outbid',
  'The Outbid Edition',
  'In August 2026, hundreds of founders paid to sit on public pay-to-rank leaderboards. This edition asks whether any of that money bought them a citation from an AI answer engine, and compares them against companies that paid nothing.'
)
on conflict (slug) do nothing;

-- ── Free checks ─────────────────────────────────────────────────────────────
-- The public "is my site cited" tool. One table doing two jobs on purpose:
--
--   cache — a repeated question about the same domain on the same day is
--           served from here, so a viral day costs one probe per domain
--           rather than one per visitor;
--   quota — rows carry a salted hash of the caller's IP, never the IP, so
--           per-day limits are enforceable without storing anyone's address.
--
-- Every check is a billed call, which is why both jobs exist before the tool
-- is published rather than after the first surprising invoice.

create table if not exists public.study_checks (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  query text not null,
  engine text not null,
  cited boolean not null,
  position int,
  source_url text,
  -- Salted SHA-256 of the caller's IP. Not reversible, not an identifier we
  -- could hand to anyone, and enough to count requests per day.
  ip_hash text,
  checked_on date not null default (timezone('utc', now()))::date,
  created_at timestamptz not null default timezone('utc', now()),
  unique (domain, query, engine, checked_on)
);

create index if not exists study_checks_quota_idx
  on public.study_checks (ip_hash, checked_on);

alter table public.study_checks enable row level security;

-- No public select: results come back through the API route, which owns the
-- quota. Exposing the table would let a caller read other people's checks and
-- would leak the ip_hash column.
create policy "Service role manages study checks"
  on public.study_checks for all to service_role using (true) with check (true);
