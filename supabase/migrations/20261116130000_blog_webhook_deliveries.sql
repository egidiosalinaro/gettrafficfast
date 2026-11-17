-- Delivery ids this site's own blog receiver has already taken
-- (app/api/gettrafficfast/route.ts, docs/BLOG.md).
--
-- Webhook deliveries are signed over a timestamp and the body
-- (lib/publishing/webhook-signature.ts), and the receiver refuses anything
-- older than five minutes. Inside that window a captured delivery would still
-- verify, so the receiver records each payload's `delivery_id` here first and
-- answers 409 to a second sight of it. Rows older than a day are pruned by the
-- receiver itself: the timestamp check already refuses them.
--
-- Written only by the service role the receiver runs as. RLS on, no policy:
-- nobody else reads or writes it.

create table if not exists public.blog_webhook_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default timezone('utc', now())
);

create index if not exists blog_webhook_deliveries_received_idx
  on public.blog_webhook_deliveries (received_at);

alter table public.blog_webhook_deliveries enable row level security;
