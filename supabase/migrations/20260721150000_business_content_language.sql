-- Explicit output language for generated content (description, keywords,
-- articles). Until now the language was implicit: the analysis wrote the
-- description in the website's language, keywords followed the description,
-- articles followed the keyword — with no way to run e.g. an English blog for
-- an Italian-language website.

alter table public.businesses
  add column if not exists content_language text not null default 'en'
  check (content_language in ('en', 'it', 'es', 'fr', 'de'));
