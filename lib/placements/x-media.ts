import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupWorstCaseUsd, xApiClientFromEnv, type XApiClient } from "@/lib/providers/x/api";
import { mediaFromProvider, type PostMediaState } from "./media";
import { NOTHING_KNOWN, referencedFromXApi, type ReferencedPosts } from "./referenced";
import { meteredXCall, type MeteredRefusal } from "./x-budget";

/**
 * The media of one post a person added by hand, and the posts it quotes and
 * replies to.
 *
 * X's oEmbed shows that a post has media (a "pic.twitter.com/…" link) but
 * never the image, and shows a quoted post only as a link. When the platform
 * has the X API (`X_API_ENABLED=1` and the token), the post is looked up by
 * id with its media and the posts it references expanded: one post
 * returned, about $0.005 (`X_LOOKUP_USD_PER_POST`), plus $0.005 for each
 * post it quotes or replies to (counted as posts read: at worst $0.015),
 * reserved and settled through `meteredXCall` under the same monthly cap as
 * the search and the reply numbers. Only for a post whose embed gives a
 * reason (media, a link that may be a quote, a reply's opening mention): a
 * post without one costs nothing.
 *
 * When the API is off, capped, paused or fails, the media are recorded as
 * unread (`unread: true`, `media: null`), never as absent: the drafter is
 * told there is an image it cannot see, and the card says so. The quoted
 * post is then read for free through the embed (x-referenced.ts).
 */

export type PostContextRead =
  | { ok: true; media: PostMediaState; referenced: ReferencedPosts }
  | { ok: false; refusal: MeteredRefusal | "not_returned"; message: string };

export async function readXPostContext(params: {
  /** The service role: the spend ledger is the platform's. */
  supabase: SupabaseClient;
  statusId: string;
  /** The X client; by default the deployment's, null when it has not opted in. */
  client?: XApiClient | null;
  capUsd?: number;
  now?: Date;
  signal?: AbortSignal;
}): Promise<PostContextRead> {
  const client = params.client === undefined ? xApiClientFromEnv() : params.client;
  const called = await meteredXCall({
    supabase: params.supabase,
    client,
    worstCaseUsd: lookupWorstCaseUsd(1, { references: true }),
    capUsd: params.capUsd,
    now: params.now,
    run: (x) => x.lookup([params.statusId], params.signal, { media: true, references: true }),
  });
  if (!called.ok) return { ok: false, refusal: called.reason, message: called.message };
  const post = called.result.posts.find((p) => p.id === params.statusId);
  if (!post) return { ok: false, refusal: "not_returned", message: "X did not return the post." };
  const media = mediaFromProvider(post.media);
  return {
    ok: true,
    media: { media, unread: post.mediaUndescribed > 0 || media.length < post.media.length },
    referenced: referencedFromXApi(post) ?? NOTHING_KNOWN,
  };
}

export interface PostMediaRead {
  state: PostMediaState;
  /** Why the media could not be read; null when they were. */
  refusal: MeteredRefusal | "not_returned" | null;
  message: string | null;
}

/** The media alone, from the same read: unread when it could not be made. */
export async function readXPostMedia(params: Parameters<typeof readXPostContext>[0]): Promise<PostMediaRead> {
  const read = await readXPostContext(params);
  if (!read.ok) return { state: { media: null, unread: true }, refusal: read.refusal, message: read.message };
  return { state: read.media, refusal: null, message: null };
}
