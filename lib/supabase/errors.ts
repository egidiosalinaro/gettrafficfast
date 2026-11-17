/**
 * Whether a Supabase error says the table (or function) is not there at all:
 * a migration not applied yet. Postgres answers `42P01` (undefined table) or
 * `42883` (undefined function); PostgREST answers `PGRST205` / `PGRST202`
 * when its schema cache has no such table or function. A guard that fails
 * open for a missing table and closed for anything else needs to tell the
 * two apart; any other error (a timeout, a refused connection) is not this.
 */
export function isMissingRelation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "42P01" || code === "42883" || code === "PGRST205" || code === "PGRST202") return true;
  const text = typeof message === "string" ? message : "";
  return /relation "[^"]+" does not exist|could not find the (table|function) .* in the schema cache/i.test(text);
}
