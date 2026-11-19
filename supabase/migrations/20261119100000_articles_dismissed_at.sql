-- Today, "Also today": a failed article can be ignored there (2026-11-19).
-- The article keeps its status and stays on the Content board; only its
-- card on Today goes. Retrying it clears the mark, so a new failure shows
-- again. Additive: a nullable column, no policy changes (articles' RLS
-- already scopes every row to its owner).
alter table public.articles
  add column if not exists dismissed_at timestamptz;

comment on column public.articles.dismissed_at is
  'When the owner ignored this failed article on Today. Null: it shows there. Cleared by retry.';
