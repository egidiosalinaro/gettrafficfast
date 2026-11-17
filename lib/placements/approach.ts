/**
 * The shape one reply takes, chosen by code before the model writes.
 *
 * A prompt can say "vary the structure", but a stateless model asked the same
 * thing for every thread converges on one shape: acknowledge, pivot, list
 * benefits, close on the product. Variety has to be dealt from outside. The
 * drafting job picks one of these from a stable hash of the target and the
 * job, so a resumed step writes the same reply and a regenerate writes a
 * different one.
 *
 * Each approach is a way a person joins a discussion. None of them is a
 * template for selling.
 */
export const APPROACHES: readonly string[] = [
  "Open with your own opinion on the question, no preamble, then back it up.",
  "Answer only the one part of the question you can add the most to, and say that is what you are doing.",
  "Push back, mildly, on part of the premise, then answer the question as it should have been asked.",
  "Walk through one concrete example from start to finish instead of listing points.",
  "Compare two ways of doing it, with the trade-off of each, without declaring a winner.",
  "Stick to a single detail or use case that fits this thread; leave everything else unsaid.",
  "Keep it short and conversational, as if typed on a phone, with one informal aside.",
  "Ask one clarifying question back, then answer the case you think is most likely.",
];

/**
 * FNV-1a over the seed, then a mixing step: cheap, stable across runs, and
 * the mix matters because FNV's low bits barely move for seeds that differ
 * only in their tail, which is exactly what "<target>:<job>" ids look like.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function pickApproach(seed: string): string {
  return APPROACHES[hash(seed) % APPROACHES.length];
}
