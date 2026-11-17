-- The blog of gettrafficfa.st, received like a customer's.
--
-- An earlier slice made the product publish to its own blog through a private
-- 'self' destination that read the articles table directly. It worked and it
-- was wrong: gettrafficfa.st is a Next.js site, so it takes its articles the
-- way every Next.js customer does, through the Webhooks integration. A private
-- path would have left the delivery code customers depend on as the one piece
-- the product never exercises on itself.
--
-- So this table is the customer side, not the platform side: it holds what the
-- webhook receiver stored, nothing else. The articles table stays what it was,
-- the product's own record of what it generated.

create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  -- The sender's stable article id: a republish must UPDATE the post, never
  -- add a twin, and the cron does retry.
  gtf_article_id text not null unique,
  -- The URL. Unique on purpose: two posts sharing a URL is worse than a
  -- delivery that fails loudly and is retried from the dashboard.
  slug text not null unique,
  title text not null,
  -- The <h1>-less body. The title is a field; rendering both is how a blog
  -- ends up with every post titled twice.
  body_html text not null,
  excerpt text,
  meta_description text,
  -- The hero is deliberately NOT inside body_html, so it is stored on its own
  -- and rendered by the page; videos likewise, since embed mechanics belong to
  -- whoever renders them.
  hero jsonb,
  videos jsonb not null default '[]'::jsonb,
  keyword text,
  published_on date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists blog_posts_published_idx
  on public.blog_posts (published_on desc nulls last);

-- Public by definition: this is the published blog. Reads are open to anyone,
-- writes only to the service role, which is what the receiver runs as.
alter table public.blog_posts enable row level security;

drop policy if exists "Blog posts are public" on public.blog_posts;
create policy "Blog posts are public"
  on public.blog_posts for select to anon, authenticated
  using (true);

drop policy if exists "Service role manages blog posts" on public.blog_posts;
create policy "Service role manages blog posts"
  on public.blog_posts for all to service_role using (true) with check (true);

-- 'self' is gone with the destination that used it.
alter table public.integrations drop constraint if exists integrations_type_check;
alter table public.integrations
  add constraint integrations_type_check
  check (type in ('wordpress', 'webflow', 'shopify', 'webhook'));
