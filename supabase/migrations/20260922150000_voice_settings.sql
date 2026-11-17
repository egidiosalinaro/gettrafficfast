-- Tone of voice, per business.
--
-- The drafts the Placements inbox proposed read like an AI marketer: the
-- competitor acknowledgement, the pivot, the benefits paragraph, the closing
-- call to action. Part of the fix is the prompt; the other part is that the
-- business had no way to say how it actually sounds, or what it can
-- truthfully say about itself — so the model either invented a history or
-- wrote as nobody.
--
-- Same shape as media_settings and automation_settings: a Zod-parsed jsonb
-- with defaults (lib/voice/settings.ts), so a new knob is a schema change and
-- old rows keep working. Read by the placement-draft agent.

alter table public.businesses
  add column if not exists voice_settings jsonb not null default '{}'::jsonb;
