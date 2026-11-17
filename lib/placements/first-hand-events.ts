/**
 * An event the writer claims happened to them, with no number in it, that
 * About you does not record.
 *
 * The case, 12 November 2026: under @hank_ships's post about being called a
 * grifter, the owner suggested a reply in the spirit of "even at zero
 * revenue, I feel the same joy when someone pays for software I built".
 * The feeling is his to state. The event is not: About you records no sale,
 * no customer, no revenue, and "when someone paid for my app" would be an
 * experience nobody recorded. The gate's experience rule only applied while
 * About you was empty, and the numbers rule needs a figure, so such a
 * sentence passed. This is the narrow, tested part code can decide: money
 * changing hands for something the writer made. Matching other prose events
 * to About you by keywords would refuse honest replies, so it stops there.
 *
 * Pure: no I/O. Read by the gate's "verifiable_claims" (lib/placements/audit.ts).
 */

const FIRST_PERSON_MADE = String.raw`(?:i|i've|i'd|we|we've)\s+(?:\w+\s+)?(?:built|build|made|make|shipped|ship|created|create|wrote|write|sell|sold|launched|launch)`;

const PAID_EVENTS: readonly RegExp[] = [
  // "someone pays for something i built", "people paid for what we made"
  new RegExp(
    String.raw`\b(?:someone|somebody|people|a (?:customer|user|stranger|client)|customers|users|clients|strangers|they)\s+(?:actually\s+|finally\s+|first\s+|really\s+)?(?:paid|pays|pay|paying|bought|buys|purchased|purchases|subscribed|subscribes)\s+(?:for\s+)?(?:something|what|the thing|stuff|anything|a thing)\s+${FIRST_PERSON_MADE}\b`,
    "i"
  ),
  // "someone paid for my app", "bought our course"
  /\b(?:(?:someone|somebody|people|a (?:customer|user|stranger|client)|customers|users|clients|strangers|they)\s+(?:actually\s+|finally\s+|first\s+|really\s+)?)?(?:paid|pays|pay|paying|bought|buys|purchased|purchases|subscribed)\s+(?:for\s+|to\s+)?(?:my|our)\s+(?:\w+\s+)?(?:app|apps|product|products|tool|tools|software|saas|course|ebook|book|template|templates|thing|startup|service|plan|subscription|side project|project)\b/i,
  // "i got my first customer", "we made our first sale", "made my first dollar"
  /\b(?:i|we)\s+(?:just\s+|finally\s+)?(?:got|had|made|landed|closed|have|hit|reached|signed)\s+(?:my|our|a|the|some|\d+|two|three)?\s*(?:first\s+)?(?:paying\s+)?(?:customers?|sales?|clients?|subscribers?|paying users?|dollars?|\$)/i,
  // "my first sale", "my revenue", "our mrr"
  /\b(?:my|our)\s+(?:first\s+)?(?:paying\s+)?(?:customers?|clients?|sales?|revenue|mrr|arr|subscribers|paying users?)\b/i,
];

/** What in About you records money for something the writer made. */
const PAID_RECORDED =
  /\b(?:paid|paying|pays|bought|purchas\w*|customers?|clients?|sales?|sold|revenue|mrr|arr|subscribers?|income|earn\w*|dollars?|usd|eur)\b|[$€£]\s?\d/i;

export interface UnrecordedEvent {
  /** The sentence of the draft that claims it. */
  sentence: string;
  /** The words that claim it. */
  quote: string;
}

/** The sentences of a text, split the way the gate splits them. */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The sentences that claim a payment, a customer, a sale or revenue of the
 * writer's own when About you records none. Empty when About you records
 * one: which one it records is prose, and that is left to the prompt.
 */
export function unrecordedEvents(body: string, aboutYou: string): UnrecordedEvent[] {
  if (PAID_RECORDED.test(aboutYou)) return [];
  const found: UnrecordedEvent[] = [];
  for (const sentence of sentencesOf(body.replace(/[’‘]/g, "'"))) {
    for (const pattern of PAID_EVENTS) {
      const match = sentence.match(pattern);
      if (match) {
        found.push({ sentence, quote: match[0] });
        break;
      }
    }
  }
  return found;
}
