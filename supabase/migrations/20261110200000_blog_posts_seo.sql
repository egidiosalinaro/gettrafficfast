-- What the blog needs to render an article's SEO and structured data, as the
-- webhook payload v5 delivers it (docs/NEXTJS_WEBHOOK_RECEIVER.md):
--
--   meta_title   the article's own title for search, when the sender has one.
--                Null means "only the headline": the page then shortens the
--                headline at a word boundary, it does not store that here.
--   faq          the article's FAQ as [{question, answer}], for FAQPage
--                JSON-LD. Null means the sender did not say (older than v5):
--                the page reads the pairs from the stored body instead. An
--                empty array means "this article has no FAQ".
--   modified_at  when the sender says the published document last changed
--                (a refresh, a link added). Null means it never did. Not the
--                same as updated_at, which moves on every delivery, a retry
--                included.
--
-- Additive and nullable: existing rows stay valid, and the receiver and the
-- page both work before and after this runs.

alter table public.blog_posts
  add column if not exists meta_title text,
  add column if not exists faq jsonb,
  add column if not exists modified_at timestamptz;
