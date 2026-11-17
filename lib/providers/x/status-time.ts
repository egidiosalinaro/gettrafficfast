/**
 * When a post on X was made, read from its id.
 *
 * Every post id X has issued since November 2010 is a "snowflake": the top
 * bits are the milliseconds since X's epoch (1288834974657, 4 November 2010)
 * at which the id was generated, which is the moment the post was made. The
 * format is X's own and public, so this is a reading of the id, not an
 * estimate: exact to the millisecond, for the posts the inbox cares about
 * (made hours ago).
 *
 * Ids from before the switch were a plain counter and carry no time. They
 * are well below the first id of 2011, so anything under that bound is left
 * unknown (null) rather than decoded into a date that never was.
 */

const X_EPOCH_MS = BigInt(1288834974657);
const TIMESTAMP_SHIFT = BigInt(22);
/** Ids generated before 1 January 2011 are not read: the counter ids sit down there. */
const FIRST_READ_MS = Date.UTC(2011, 0, 1);

/** The ISO instant the post with this id was made, or null when the id does not carry one. */
export function xStatusPostedAt(statusId: string, now: Date = new Date()): string | null {
  if (!/^\d{1,20}$/.test(statusId)) return null;
  const ms = Number((BigInt(statusId) >> TIMESTAMP_SHIFT) + X_EPOCH_MS);
  // Before 2011 is the counter era; a moment in the future is not a post.
  if (ms < FIRST_READ_MS || ms > now.getTime() + 86_400_000) return null;
  return new Date(ms).toISOString();
}
