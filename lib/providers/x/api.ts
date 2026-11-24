import { z } from "zod";

/**
 * The official X API v2, read-only, with an app-only Bearer token.
 *
 * Three endpoints and nothing else: recent search
 * (`GET /2/tweets/search/recent`, the last 7 days) to find fresh posts and
 * the person's own reply in a thread (`searchReplies`), post lookup by ids
 * (`GET /2/tweets?ids=`) to read the public numbers of replies a person
 * posted, and user lookup by username (`GET /2/users/by/username/:username`)
 * to read the public numbers of the site's own account (followers). No
 * write endpoint is called here: posting, which only ever follows a person's
 * press of Post, acts with the site's connected account (user context), in
 * post.ts and oauth.ts.
 *
 * Billing is pay-per-use (X's default model since 2026-02-06), per post
 * returned. The unit prices below are the only place a price is written;
 * the cap (lib/placements/x-budget.ts) estimates a call's worst case from
 * them before it is made and records the estimate after. They come from
 * third-party summaries, not from X's own price list or an invoice: treat
 * them as configuration and correct them when the first invoice says
 * otherwise.
 *
 * Opt-in twice over, as every paid source is: `X_API_ENABLED=1` AND
 * `X_API_BEARER_TOKEN`. The key alone spends nothing.
 *
 * This file only speaks HTTP and classifies what X answered. It reads no
 * table and holds no cap; it is handed a `fetch` so tests never reach X.
 */

export const X_API_BASE = "https://api.x.com/2";

/**
 * USD per post returned by recent search. Source: third-party summaries of
 * X's pay-per-use pricing, September 2026 ("about $0.005 per post read").
 * Recorded 2026-11-11. The author objects and the media objects X expands
 * beside the posts (`includes.users`, `includes.media`) are assumed to be
 * part of that read: X documents pay-per-use as billed per post (resource)
 * returned, and an expansion describes the post rather than returning
 * another one. Not confirmed by an invoice: check the first one and raise
 * this if expansions are billed apart.
 *
 * The posts a post quotes or replies to (`includes.tweets`, asked for since
 * 2026-11-14 through `referenced_tweets.id`) ARE posts: they are counted as
 * posts read, at this same unit price, in the worst case reserved before the
 * call (`X_REFERENCED_PER_POST_MAX` more per post asked for) and in the cost
 * settled after it (every distinct post X included). Whether X bills them is
 * not confirmed either; counting them is the side that never under-reserves.
 */
export const X_SEARCH_USD_PER_POST = 0.005;

/**
 * USD per post returned by a lookup by ids. Source: the same third-party
 * summaries, September 2026: about $0.005 per post read with an app-only
 * token (reads of one's own data with user auth are cheaper, about $0.001,
 * but this client has no user auth). Recorded 2026-11-11.
 */
export const X_LOOKUP_USD_PER_POST = 0.005;

/**
 * USD per user returned by a user lookup (`GET /2/users/by/username/:username`).
 * Source: third-party summaries of X's pay-per-use pricing, 2026 ("$0.005
 * per post read, $0.010 per user read"). Recorded 2026-11-13. Not confirmed
 * by an invoice: check the first one and correct this if it disagrees.
 */
export const X_USER_LOOKUP_USD_PER_USER = 0.01;

/**
 * The most posts one post can reference that are read beside it: the post it
 * quotes and the post it replies to (a repost references one post and is
 * neither). What a call that asks for them reserves per post asked for, on
 * top of the post itself.
 */
export const X_REFERENCED_PER_POST_MAX = 2;

/** X's own bounds on `max_results` for recent search. */
export const X_SEARCH_MIN_RESULTS = 10;
export const X_SEARCH_MAX_RESULTS = 100;
/** X's bound on ids per lookup. */
export const X_LOOKUP_MAX_IDS = 100;
/** X's bound on a recent search query's length with this access level. */
export const X_QUERY_MAX_CHARS = 512;

/** Long enough for a slow answer, short enough that a stuck call does not hold the job. */
export const X_API_TIMEOUT_MS = 15_000;

export const DEFAULT_X_MONTHLY_CAP_USD = 20;

type Env = Record<string, string | undefined>;

/** True only when the platform opted in AND a token is there. */
export function isXApiEnabled(env: Env = process.env): boolean {
  const flag = (env.X_API_ENABLED ?? "").trim().toLowerCase();
  return (flag === "1" || flag === "true") && Boolean(env.X_API_BEARER_TOKEN?.trim());
}

/**
 * The hard monthly cap in USD, `X_API_MONTHLY_CAP_USD`, default $20. A value
 * that does not read as a non-negative number falls back to the default:
 * a typo must not lift the cap.
 */
export function xMonthlyCapUsd(env: Env = process.env): number {
  const raw = env.X_API_MONTHLY_CAP_USD?.trim();
  if (!raw) return DEFAULT_X_MONTHLY_CAP_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_X_MONTHLY_CAP_USD;
}

/** Posts billed at worst per post asked for: the post, and with `references` the two it may quote and reply to. */
function postsPerPost(options: { references?: boolean }): number {
  return 1 + (options.references ? X_REFERENCED_PER_POST_MAX : 0);
}

/**
 * The worst a recent search can cost: every post it may return, billed, and
 * with `references`, the posts each may quote and reply to.
 */
export function searchWorstCaseUsd(maxResults: number, options: { references?: boolean } = {}): number {
  return roundUsd(clampResults(maxResults) * postsPerPost(options) * X_SEARCH_USD_PER_POST);
}

/** The worst a lookup of `ids` can cost (with `references`, the posts each may quote and reply to). */
export function lookupWorstCaseUsd(ids: number, options: { references?: boolean } = {}): number {
  return roundUsd(Math.min(Math.max(0, ids), X_LOOKUP_MAX_IDS) * postsPerPost(options) * X_LOOKUP_USD_PER_POST);
}

/** The worst a lookup of one account costs: the one user it may return, billed. */
export function userLookupWorstCaseUsd(): number {
  return roundUsd(X_USER_LOOKUP_USD_PER_USER);
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

function clampResults(n: number): number {
  return Math.min(X_SEARCH_MAX_RESULTS, Math.max(X_SEARCH_MIN_RESULTS, Math.floor(n)));
}

/**
 * Why a call failed, in the terms the caller acts on:
 *   configuration — 401/403: the token is wrong, revoked, or the app has no access;
 *   rate_limit    — 429: wait until `resetAt`;
 *   billing       — 402, or X saying the credits are depleted: pause and tell the operator;
 *   timeout       — no answer in time;
 *   http          — anything else X answered with;
 *   invalid       — an answer that does not have the shape the endpoint documents.
 */
export type XApiErrorKind = "configuration" | "rate_limit" | "billing" | "timeout" | "http" | "invalid";

export class XApiError extends Error {
  constructor(
    message: string,
    readonly kind: XApiErrorKind,
    readonly details: { status?: number; resetAt?: string | null } = {}
  ) {
    super(message);
    this.name = "XApiError";
  }
  get status(): number | undefined {
    return this.details.status;
  }
  get resetAt(): string | null {
    return this.details.resetAt ?? null;
  }
}

/** X saying the account's credits are used up, in any of the ways it words it: billing, whatever the status. */
export const BILLING_TEXT_PATTERN = /credits?\s*(are\s*|have\s*been\s*)?depleted|creditsdepleted|insufficient\s*credits|payment\s*required|usage\s*cap|spend\s*cap/i;

/** `x-rate-limit-reset` (epoch seconds) as an ISO instant, or null. */
export function rateLimitResetAt(header: string | null): string | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** What an HTTP failure means, from the status and the body X sent. */
export function classifyXFailure(status: number, body: string, resetHeader: string | null): XApiError {
  const excerpt = body.slice(0, 300);
  if (status === 402 || BILLING_TEXT_PATTERN.test(body)) {
    return new XApiError(`X API billing refused (${status}): ${excerpt}`, "billing", { status });
  }
  if (status === 429) {
    const resetAt = rateLimitResetAt(resetHeader);
    return new XApiError(`X API rate limit (429)${resetAt ? `, resets at ${resetAt}` : ""}`, "rate_limit", { status, resetAt });
  }
  if (status === 401 || status === 403) {
    return new XApiError(`X API refused the token (${status}): ${excerpt}`, "configuration", { status });
  }
  return new XApiError(`X API failed (${status}): ${excerpt}`, "http", { status });
}

const PublicMetrics = z
  .object({
    impression_count: z.number().optional(),
    like_count: z.number().optional(),
    reply_count: z.number().optional(),
    retweet_count: z.number().optional(),
    quote_count: z.number().optional(),
    bookmark_count: z.number().optional(),
  })
  .passthrough();

const ApiPost = z
  .object({
    id: z.string().regex(/^\d{1,20}$/),
    text: z.string(),
    attachments: z.object({ media_keys: z.array(z.string()).optional() }).passthrough().optional(),
    author_id: z.string().optional(),
    created_at: z.string().optional(),
    lang: z.string().optional(),
    note_tweet: z.object({ text: z.string() }).passthrough().optional(),
    public_metrics: PublicMetrics.optional(),
    // Asked for by `searchReplies` only: where the post sits in its thread.
    conversation_id: z.string().optional(),
    referenced_tweets: z.array(z.object({ type: z.string(), id: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const ApiUser = z.object({ id: z.string(), username: z.string(), name: z.string().optional() }).passthrough();

const ApiMedia = z
  .object({
    media_key: z.string(),
    type: z.string(),
    url: z.string().optional(),
    preview_image_url: z.string().optional(),
    alt_text: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

const ApiResponse = z
  .object({
    data: z.array(ApiPost).optional(),
    includes: z
      .object({ users: z.array(ApiUser).optional(), media: z.array(z.unknown()).optional(), tweets: z.array(z.unknown()).optional() })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ resource_id: z.string().optional() }).passthrough()).optional(),
    meta: z.object({ result_count: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

/** A post as this product uses it. A number X did not send is null, never 0. */
export interface XApiPost {
  id: string;
  /** The whole text: a long post's `note_tweet` when X sends it. */
  text: string;
  authorId: string | null;
  /** The account, without "@", when X expanded the author. */
  handle: string | null;
  authorName: string | null;
  createdAt: string | null;
  lang: string | null;
  metrics: XPostMetrics;
  /**
   * The post's media X described (`includes.media`, by the post's
   * `attachments.media_keys`), in the post's order. Empty when the post has
   * none or the call did not ask for them.
   */
  media: XMedia[];
  /**
   * Media keys the post carries that X did not describe: media exists that
   * could not be read. 0 for a post with no attachment.
   */
  mediaUndescribed: number;
  /**
   * The thread the post belongs to (the id of the post that started it), when
   * the call asked for it (`searchReplies`). Absent otherwise: unknown.
   */
  conversationId?: string | null;
  /** The post this one answers, when it is a reply and the call asked for it (`searchReplies`). */
  repliedToId?: string | null;
  /**
   * The post this one quotes and the post it replies to, when the call asked
   * for them (`references`): one entry per relation the post has, with the
   * referenced post as X included it, or `post: null` when X referenced it
   * and did not include it (deleted, protected, withheld): it exists and
   * could not be read. Absent when the call did not ask: unknown.
   */
  references?: XReference[];
}

/** A post another post quotes or replies to, as X included it (`includes.tweets`). */
export interface XIncludedPost {
  id: string;
  /** The whole text: a long post's `note_tweet` when X sends it. */
  text: string;
  authorId: string | null;
  handle: string | null;
  authorName: string | null;
  createdAt: string | null;
  media: XMedia[];
  mediaUndescribed: number;
}

export interface XReference {
  relation: "quoted" | "replied_to";
  id: string;
  /** Null when X did not include the post it references. */
  post: XIncludedPost | null;
}

/**
 * One photo, video or GIF of a post, as X describes it. `url` is a photo's
 * own image; a video or a GIF has none, only `previewUrl`, its still. A URL
 * that is not https on X's media host is dropped (null): nothing else is
 * ever fetched from what X answers.
 */
export interface XMedia {
  type: string;
  url: string | null;
  previewUrl: string | null;
  altText: string | null;
  width: number | null;
  height: number | null;
}

/** X's media fields asked for beside the posts. */
export const X_MEDIA_FIELDS = "type,url,preview_image_url,alt_text,width,height";

/** True for an https URL on X's media CDN (pbs.twimg.com and its siblings). */
export function isXMediaUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "twimg.com" || url.hostname.endsWith(".twimg.com"));
  } catch {
    return false;
  }
}

function dimension(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** `includes.media` by media key, each item read on its own: one malformed item costs that item only. */
export function mediaByKey(raw: unknown[] | undefined): Map<string, XMedia> {
  const out = new Map<string, XMedia>();
  for (const item of raw ?? []) {
    const parsed = ApiMedia.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data;
    out.set(m.media_key, {
      type: m.type,
      url: isXMediaUrl(m.url) ? (m.url as string) : null,
      previewUrl: isXMediaUrl(m.preview_image_url) ? (m.preview_image_url as string) : null,
      altText: m.alt_text?.trim() ? m.alt_text.trim().slice(0, 1_000) : null,
      width: dimension(m.width),
      height: dimension(m.height),
    });
  }
  return out;
}

export interface XPostMetrics {
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  bookmarks: number | null;
}

function num(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function metricsOf(raw: z.infer<typeof PublicMetrics> | undefined): XPostMetrics {
  return {
    impressions: num(raw?.impression_count),
    likes: num(raw?.like_count),
    replies: num(raw?.reply_count),
    reposts: num(raw?.retweet_count),
    quotes: num(raw?.quote_count),
    bookmarks: num(raw?.bookmark_count),
  };
}

const REFERENCE_RELATIONS = new Set(["quoted", "replied_to"]);

/**
 * `includes.tweets` by id, each item read on its own: one malformed item
 * costs that item only (it then reads as referenced and not included).
 */
export function includedPostsById(
  raw: unknown[] | undefined,
  users: ReadonlyMap<string, z.infer<typeof ApiUser>>,
  media: ReadonlyMap<string, XMedia>
): Map<string, XIncludedPost> {
  const out = new Map<string, XIncludedPost>();
  for (const item of raw ?? []) {
    const parsed = ApiPost.safeParse(item);
    if (!parsed.success) continue;
    const post = parsed.data;
    const user = post.author_id ? users.get(post.author_id) : undefined;
    const keys = post.attachments?.media_keys ?? [];
    const described = keys.map((key) => media.get(key)).filter((m): m is XMedia => m !== undefined);
    out.set(post.id, {
      id: post.id,
      text: post.note_tweet?.text || post.text,
      authorId: post.author_id ?? null,
      handle: user?.username ?? null,
      authorName: user?.name ?? null,
      createdAt: post.created_at ?? null,
      media: described,
      mediaUndescribed: keys.length - described.length,
    });
  }
  return out;
}

/**
 * A documented answer as posts; throws `invalid` when it is not one. With
 * `references`, each post carries the posts it quotes and replies to, and
 * `included` counts the distinct posts X included beside the answer (billed
 * as posts read: see X_SEARCH_USD_PER_POST).
 */
export function parseXPosts(
  payload: unknown,
  options: { references?: boolean } = {}
): { posts: XApiPost[]; missingIds: string[]; included: number } {
  const parsed = ApiResponse.safeParse(payload);
  if (!parsed.success) throw new XApiError("X API answered in an unexpected shape", "invalid");
  const users = new Map((parsed.data.includes?.users ?? []).map((u) => [u.id, u]));
  const media = mediaByKey(parsed.data.includes?.media);
  const included = options.references ? includedPostsById(parsed.data.includes?.tweets, users, media) : new Map<string, XIncludedPost>();
  // Every distinct post X included is counted as read, a malformed one too.
  const includedIds = new Set(
    (parsed.data.includes?.tweets ?? []).flatMap((item) => {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      return typeof id === "string" ? [id] : [];
    })
  );
  const posts = (parsed.data.data ?? []).map((post): XApiPost => {
    const user = post.author_id ? users.get(post.author_id) : undefined;
    const keys = post.attachments?.media_keys ?? [];
    const described = keys.map((key) => media.get(key)).filter((m): m is XMedia => m !== undefined);
    return {
      id: post.id,
      text: post.note_tweet?.text || post.text,
      authorId: post.author_id ?? null,
      handle: user?.username ?? null,
      authorName: user?.name ?? null,
      createdAt: post.created_at ?? null,
      lang: post.lang ?? null,
      metrics: metricsOf(post.public_metrics),
      media: described,
      mediaUndescribed: keys.length - described.length,
      // Only when X sent them: a call that did not ask leaves them unknown.
      ...(post.conversation_id !== undefined ? { conversationId: post.conversation_id } : {}),
      ...(post.referenced_tweets !== undefined
        ? { repliedToId: post.referenced_tweets.find((ref) => ref.type === "replied_to")?.id ?? null }
        : post.conversation_id !== undefined
          ? { repliedToId: null }
          : {}),
      ...(options.references
        ? {
            references: (post.referenced_tweets ?? [])
              .filter((ref) => REFERENCE_RELATIONS.has(ref.type) && /^\d{1,20}$/.test(ref.id))
              .map((ref) => ({ relation: ref.type as XReference["relation"], id: ref.id, post: included.get(ref.id) ?? null })),
          }
        : {}),
    };
  });
  const missingIds = (parsed.data.errors ?? [])
    .map((e) => e.resource_id)
    .filter((id): id is string => typeof id === "string");
  return { posts, missingIds, included: options.references ? includedIds.size : 0 };
}

const ApiUserResponse = z
  .object({
    data: z
      .object({
        id: z.string().regex(/^\d{1,20}$/),
        username: z.string(),
        public_metrics: z
          .object({
            followers_count: z.number().optional(),
            following_count: z.number().optional(),
            tweet_count: z.number().optional(),
            listed_count: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** An account's public numbers. A number X did not send is null, never 0. */
export interface XAccountMetrics {
  followers: number | null;
  following: number | null;
  /** All the posts the account ever made (X's `tweet_count`). */
  posts: number | null;
  /** The public lists the account is on. */
  listed: number | null;
}

export interface XAccount {
  /** X's id of the account: it survives a rename, the handle does not. */
  id: string;
  /** As X spells it, without "@". */
  handle: string;
  metrics: XAccountMetrics;
}

/**
 * A documented user lookup answer as the account, or null when X answered
 * with no user (unknown handle, suspended account: X puts those in
 * `errors` with a 200). Throws `invalid` when the answer has another shape.
 */
export function parseXUser(payload: unknown): XAccount | null {
  const parsed = ApiUserResponse.safeParse(payload);
  if (!parsed.success) throw new XApiError("X API answered in an unexpected shape", "invalid");
  const user = parsed.data.data;
  if (!user) return null;
  const m = user.public_metrics;
  return {
    id: user.id,
    handle: user.username,
    metrics: {
      followers: num(m?.followers_count),
      following: num(m?.following_count),
      posts: num(m?.tweet_count),
      listed: num(m?.listed_count),
    },
  };
}

/** What a user lookup returned and what it is billed. */
export interface XUserLookupResult {
  /** The account, or null when X returned no user for the handle. */
  account: XAccount | null;
  /**
   * Resources X bills the call on: the user it returned (1), or none (0).
   * Named as on the post reads, so one ledger (`provider_spend.posts`, the
   * resources returned) settles every X call.
   */
  billedPosts: number;
  /** `billedPosts` × the user lookup's unit price. An estimate. */
  costUsd: number;
}

export interface XCallResult {
  posts: XApiPost[];
  /** Ids asked for that X did not return (deleted, protected, not found). Lookup only. */
  missingIds: string[];
  /**
   * Posts X returned, and with `references` the distinct posts it included
   * beside them (quoted, replied to): what the call is billed on.
   */
  billedPosts: number;
  /** `billedPosts` × the endpoint's unit price. An estimate. */
  costUsd: number;
}

export interface XApiClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

function defaultLog(line: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "x_api", ...line }));
}

const POST_FIELDS = "created_at,author_id,lang,public_metrics,note_tweet,attachments";
/** With the posts referenced: which ones a post quotes and replies to. */
const POST_FIELDS_WITH_REFERENCES = `${POST_FIELDS},referenced_tweets`;

/**
 * The expansions of a read that wants the post's author and media, and the
 * posts it quotes and replies to with their authors and media. The request
 * changes; what is billed is the posts returned and included (see
 * X_SEARCH_USD_PER_POST).
 */
export const X_REFERENCE_EXPANSIONS =
  "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys";

export class XApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: (line: Record<string, unknown>) => void;

  constructor(private readonly options: XApiClientOptions) {
    if (!options.token) throw new XApiError("X_API_BEARER_TOKEN is not set", "configuration");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? X_API_TIMEOUT_MS;
    this.log = options.log ?? defaultLog;
  }

  /** Posts matching `query` made after `startTime`, at most `maxResults` (10 to 100). */
  async searchRecent(params: {
    query: string;
    maxResults: number;
    startTime: Date;
    signal?: AbortSignal;
  }): Promise<XCallResult> {
    if (params.query.length > X_QUERY_MAX_CHARS) {
      throw new XApiError(`X search query is ${params.query.length} characters; the limit is ${X_QUERY_MAX_CHARS}`, "invalid");
    }
    const search = new URLSearchParams({
      query: params.query,
      max_results: String(clampResults(params.maxResults)),
      start_time: params.startTime.toISOString().replace(/\.\d{3}Z$/, "Z"),
      "tweet.fields": POST_FIELDS_WITH_REFERENCES,
      // The media are expanded in the same call: the request changes, not
      // the posts returned, which is what X bills (see X_SEARCH_USD_PER_POST).
      // So are the posts each one quotes or replies to (2026-11-14): those
      // are posts, counted as read (`searchWorstCaseUsd(n, { references })`).
      expansions: X_REFERENCE_EXPANSIONS,
      "user.fields": "username,name",
      "media.fields": X_MEDIA_FIELDS,
    });
    return this.call("search_recent", `${X_API_BASE}/tweets/search/recent?${search.toString()}`, X_SEARCH_USD_PER_POST, params.signal, {
      references: true,
    });
  }

  /**
   * Replies matching `query` (a thread and an account: lib/placements/
   * reply-link.ts) made between `startTime` and `endTime`, each with where it
   * sits in its thread (`conversation_id`, the post it replies to) and its
   * author. The same endpoint and price as `searchRecent`; its own method so
   * the fields asked for are only those this use reads.
   */
  async searchReplies(params: {
    query: string;
    maxResults: number;
    startTime: Date;
    /** Omitted when null: X wants it at least 10 seconds in the past. */
    endTime?: Date | null;
    signal?: AbortSignal;
  }): Promise<XCallResult> {
    if (params.query.length > X_QUERY_MAX_CHARS) {
      throw new XApiError(`X search query is ${params.query.length} characters; the limit is ${X_QUERY_MAX_CHARS}`, "invalid");
    }
    const search = new URLSearchParams({
      query: params.query,
      max_results: String(clampResults(params.maxResults)),
      start_time: xInstant(params.startTime),
      "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets,note_tweet",
      expansions: "author_id",
      "user.fields": "username,name",
    });
    if (params.endTime) search.set("end_time", xInstant(params.endTime));
    return this.call("search_replies", `${X_API_BASE}/tweets/search/recent?${search.toString()}`, X_SEARCH_USD_PER_POST, params.signal);
  }

  /**
   * The posts with these ids and their public numbers; ids X does not return
   * are listed apart. With `media`, their media too (and the author), for a
   * post a person added by hand, whose oEmbed carries no image URL. With
   * `references`, also the posts each quotes and replies to, with their
   * authors and media (the post's own media and author too): billed as
   * posts read.
   */
  async lookup(ids: string[], signal?: AbortSignal, options: { media?: boolean; references?: boolean } = {}): Promise<XCallResult> {
    const unique = [...new Set(ids.filter((id) => /^\d{1,20}$/.test(id)))];
    if (unique.length === 0) return { posts: [], missingIds: [], billedPosts: 0, costUsd: 0 };
    if (unique.length > X_LOOKUP_MAX_IDS) {
      throw new XApiError(`X lookup takes at most ${X_LOOKUP_MAX_IDS} ids; got ${unique.length}`, "invalid");
    }
    const search = new URLSearchParams({ ids: unique.join(","), "tweet.fields": options.references ? POST_FIELDS_WITH_REFERENCES : POST_FIELDS });
    if (options.media || options.references) {
      search.set("expansions", options.references ? X_REFERENCE_EXPANSIONS : "author_id,attachments.media_keys");
      search.set("user.fields", "username,name");
      search.set("media.fields", X_MEDIA_FIELDS);
    }
    const result = await this.call("lookup", `${X_API_BASE}/tweets?${search.toString()}`, X_LOOKUP_USD_PER_POST, signal, {
      references: options.references,
    });
    const returned = new Set(result.posts.map((p) => p.id));
    const missing = new Set([...result.missingIds, ...unique.filter((id) => !returned.has(id))]);
    return { ...result, missingIds: [...missing] };
  }

  /**
   * The public numbers of one account, by its handle (with or without "@").
   * One call, billed per user returned: a handle X does not know returns
   * none and is billed nothing.
   */
  async userByUsername(username: string, signal?: AbortSignal): Promise<XUserLookupResult> {
    const handle = username.trim().replace(/^@/, "");
    if (!/^\w{1,15}$/.test(handle)) throw new XApiError(`Not an X handle: ${handle.slice(0, 40)}`, "invalid");
    const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics`;
    const { payload, status, started } = await this.fetchJson("user_by_username", url, signal);
    const account = parseXUser(payload);
    const billed = account ? 1 : 0;
    const costUsd = roundUsd(billed * X_USER_LOOKUP_USD_PER_USER);
    this.log({ endpoint: "user_by_username", outcome: account ? "ok" : "not_found", status, users: billed, posts: 0, est_cost_usd: costUsd, ms: Date.now() - started });
    return { account, billedPosts: billed, costUsd };
  }

  private async call(
    endpoint: string,
    url: string,
    unitUsd: number,
    parent?: AbortSignal,
    options: { references?: boolean } = {}
  ): Promise<XCallResult> {
    const { payload, status, started } = await this.fetchJson(endpoint, url, parent);
    const { posts, missingIds, included } = parseXPosts(payload, options);
    // The posts X included beside the answer are counted as read.
    const billed = posts.length + included;
    const costUsd = roundUsd(billed * unitUsd);
    this.log({ endpoint, outcome: "ok", status, posts: posts.length, included, est_cost_usd: costUsd, ms: Date.now() - started });
    return { posts, missingIds, billedPosts: billed, costUsd };
  }

  /** One GET, its failure classified and logged; the JSON X answered with. */
  private async fetchJson(endpoint: string, url: string, parent?: AbortSignal): Promise<{ payload: unknown; status: number; started: number }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" },
        signal,
      });
    } catch (err) {
      const timedOut = timeout.aborted || (err instanceof Error && err.name === "TimeoutError");
      this.log({ endpoint, outcome: timedOut ? "timeout" : "network_error", posts: 0, est_cost_usd: 0, ms: Date.now() - started });
      throw new XApiError(
        timedOut ? `X API did not answer within ${this.timeoutMs} ms` : `X API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        timedOut ? "timeout" : "http"
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = classifyXFailure(response.status, body, response.headers.get("x-rate-limit-reset"));
      this.log({ endpoint, outcome: error.kind, status: response.status, posts: 0, est_cost_usd: 0, reset_at: error.resetAt, ms: Date.now() - started });
      throw error;
    }

    try {
      return { payload: await response.json(), status: response.status, started };
    } catch {
      this.log({ endpoint, outcome: "invalid", status: response.status, posts: 0, est_cost_usd: 0, ms: Date.now() - started });
      throw new XApiError("X API answered with something that is not JSON", "invalid", { status: response.status });
    }
  }
}

/** An instant as X's time parameters take it: seconds, no milliseconds. */
function xInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The client for this deployment, or null when the platform has not opted in. */
export function xApiClientFromEnv(env: Env = process.env, options: Omit<XApiClientOptions, "token"> = {}): XApiClient | null {
  if (!isXApiEnabled(env)) return null;
  return new XApiClient({ ...options, token: (env.X_API_BEARER_TOKEN as string).trim() });
}
