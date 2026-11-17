-- tool_calls by age, for the daily retention sweep (docs/API.md "Limits and
-- the audit log", lib/tools/retention.ts): /api/cron/prune-tool-calls
-- deletes rows older than 90 days, oldest first, in batches, and each batch
-- reads the oldest expired rows. The existing indexes lead with the key or
-- the user, so without this one every batch would scan the table.
--
-- Only the index is here. The delete runs in that route through the service
-- role at runtime, never in a migration.

create index if not exists tool_calls_created_idx on public.tool_calls (created_at);
