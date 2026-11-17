## What and why

<!-- What changes, and the problem it solves. Link the issue if there is one. -->

## How it was checked

<!-- The flows you exercised end to end, beyond the tests. -->

## Checklist

- [ ] `npm run lint`, `npx tsc --noEmit` and `npx vitest run` pass locally.
- [ ] Tests added or updated in `tests/`, mirroring `lib/`.
- [ ] Agent and API inputs/outputs validated with Zod; layers depend downward only; no vendor name above `lib/providers/`.
- [ ] Measurements stay honest: no samples is `null`, never `0`; negative results stored; rates per engine.
- [ ] Any new paid call is opt-in behind an env var, bounded and capped (cost per run stated below).
- [ ] A new screen action has its MCP tool (`tests/tools/parity.test.ts` passes).
- [ ] `docs/` and, if a customer or their agent can see it, the public docs (`app/docs`, `components/docs/`) updated in this PR.
- [ ] Migrations: timestamp-prefixed in `supabase/migrations/`, RLS on every new table, no destructive statements (or explained below).
- [ ] Every commit is signed off (`git commit -s`, DCO).

## Cost, migrations, risks

<!-- Paid calls per run and their cap; what a migration does to existing rows; anything a reviewer should look at twice. Write "none" if none. -->
