import { SITE_URL } from "@/lib/site";
/**
 * When a public post was made, asked of the platform's own free API.
 *
 * A web search finds a thread with a URL and, often, no date: Google prints
 * one beside a result only sometimes. Where the URL itself carries the time
 * (an X or LinkedIn id) it is read without asking anyone
 * (lib/placements/date-from-url.ts). For the rest, the platforms that answer
 * "when was this posted" without a key are asked here, and nothing else:
 *
 *   hackernews     Firebase item API, `time` (Unix seconds).
 *   stackexchange  API 2.3 `/questions/{ids}?site=<host>`, `creation_date`.
 *                  Up to 100 ids per request, per site; 300 requests a day
 *                  per address without a key, so a run sends very few.
 *   devto          `/api/articles/<user>/<slug>`, `published_at`.
 *   reddit         `/comments/<id>.json`, `created_utc`. Reddit's Data API
 *                  needs an approved app (docs/PLACEMENTS.md); the public JSON
 *                  may still answer, or may be blocked. Best effort: a
 *                  refusal stops Reddit for the run and the date stays
 *                  unknown.
 *   github         REST `/repos/<o>/<r>/issues/<n>`, `created_at`, for an
 *                  issue a web search found. With GITHUB_TOKEN when the
 *                  deployment has one; 60 an hour per address without.
 *
 * Free, so no opt-in: nothing here is billed, and a refusal costs a date,
 * never a run. Every request has a timeout, every source a per-run cap,
 * and a source that answers 403 or 429 is not asked again in the run. A
 * failure, a timeout, a missing field or a date outside the plausible range
 * leaves the date unknown (null): never "now", never a guess.
 */

export type PostDateRequest =
  | { source: "hackernews"; id: string }
  | { source: "stackexchange"; site: string; id: string }
  | { source: "devto"; user: string; slug: string }
  | { source: "reddit"; id: string }
  | { source: "github"; repo: string; number: string };

export type PostDateSource = PostDateRequest["source"];

export const POST_DATE_SOURCES: readonly PostDateSource[] = ["hackernews", "stackexchange", "devto", "reddit", "github"];

/**
 * Requests per source per run (one discovery job, one site). Stack Exchange
 * batches 100 questions a request, so 3 covers 300 questions and 25 sites a
 * cron day stay at 75 of the 300 a day the address is allowed. Reddit and
 * GitHub are small because they are the likeliest to refuse.
 */
export const POST_DATE_CAPS: Readonly<Record<PostDateSource, number>> = {
  hackernews: 40,
  stackexchange: 3,
  devto: 20,
  reddit: 10,
  github: 15,
};

/** Wall clock per request. */
export const POST_DATE_TIMEOUT_MS = 4_000;

/** Requests in flight at once, across every source. */
const CONCURRENCY = 4;

const STACK_EXCHANGE_BATCH = 100;

const USER_AGENT = `gettrafficfast-post-dates (+${SITE_URL})`;

/** Nothing these platforms host was posted before 2005 (Reddit's first year). */
const EARLIEST_MS = Date.UTC(2005, 0, 1);
const DAY_MS = 86_400_000;

/** The ISO instant for `ms`, or null when it is not a plausible post time. */
function plausible(ms: number, now: Date): string | null {
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > now.getTime() + DAY_MS) return null;
  return new Date(ms).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// ── Pure parsers, one per platform: payload in, ISO instant or null out ──────

/** Hacker News item: `time` in Unix seconds. A deleted item keeps its time. */
export function parseHackerNewsItem(payload: unknown, now: Date = new Date()): string | null {
  const time = record(payload)?.time;
  return typeof time === "number" ? plausible(time * 1000, now) : null;
}

/** Stack Exchange `/questions/{ids}`: question id → creation instant. A deleted question is absent. */
export function parseStackExchangeQuestions(payload: unknown, now: Date = new Date()): Map<string, string> {
  const out = new Map<string, string>();
  const items = record(payload)?.items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const row = record(item);
    const id = row?.question_id;
    const created = row?.creation_date;
    if ((typeof id !== "number" && typeof id !== "string") || typeof created !== "number") continue;
    const at = plausible(created * 1000, now);
    if (at) out.set(String(id), at);
  }
  return out;
}

/** DEV article: `published_at`, ISO. An unpublished article has none. */
export function parseDevToArticle(payload: unknown, now: Date = new Date()): string | null {
  const published = record(payload)?.published_at;
  return typeof published === "string" ? plausible(Date.parse(published), now) : null;
}

/**
 * Reddit `/comments/<id>.json`: an array of two listings, the first holding
 * the post (`t3`) with `created_utc` in Unix seconds. A single listing (the
 * shape of `/by_id/`) is read the same way.
 */
export function parseRedditPost(payload: unknown, id: string, now: Date = new Date()): string | null {
  const listings = Array.isArray(payload) ? payload : [payload];
  for (const listing of listings) {
    const children = record(record(listing)?.data)?.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const entry = record(child);
      const data = record(entry?.data);
      if (entry?.kind !== "t3" || !data) continue;
      if (typeof data.id === "string" && data.id.toLowerCase() !== id.toLowerCase()) continue;
      const created = data.created_utc;
      if (typeof created === "number") return plausible(created * 1000, now);
    }
  }
  return null;
}

/** GitHub issue: `created_at`, ISO. */
export function parseGitHubIssue(payload: unknown, now: Date = new Date()): string | null {
  const created = record(payload)?.created_at;
  return typeof created === "string" ? plausible(Date.parse(created), now) : null;
}

// ── The lookup ───────────────────────────────────────────────────────────────

/** The key a request is cached and answered under: one per post. */
export function postDateKey(request: PostDateRequest): string {
  switch (request.source) {
    case "hackernews":
      return `hackernews:${request.id}`;
    case "stackexchange":
      return `stackexchange:${request.site.toLowerCase()}:${request.id}`;
    case "devto":
      return `devto:${request.user.toLowerCase()}/${request.slug.toLowerCase()}`;
    case "reddit":
      return `reddit:${request.id.toLowerCase()}`;
    case "github":
      return `github:${request.repo.toLowerCase()}#${request.number}`;
  }
}

export interface PostDateStats {
  /** HTTP requests sent, per source. */
  requests: Record<PostDateSource, number>;
  /** Posts dated, per source. */
  dated: Record<PostDateSource, number>;
  /** Posts not asked: the source's cap, a refusal earlier in the run, or the time budget. */
  skipped: Record<PostDateSource, number>;
  /** Requests that failed (an HTTP error, a timeout, a payload without the field). */
  failed: Record<PostDateSource, number>;
}

const zero = (): Record<PostDateSource, number> => ({ hackernews: 0, stackexchange: 0, devto: 0, reddit: 0, github: 0 });

export interface PostDateLookupOptions {
  fetch?: typeof fetch;
  caps?: Partial<Record<PostDateSource, number>>;
  timeoutMs?: number;
  /** Sent to GitHub when present; raises its limit. */
  githubToken?: string | null;
  /** The clock the plausible range is checked against. */
  now?: () => Date;
  /** Epoch ms after which no new request starts. */
  deadline?: number;
  signal?: AbortSignal;
}

class Refused extends Error {
  constructor(readonly status: number) {
    super(`refused (${status})`);
  }
}

interface Task {
  source: PostDateSource;
  url: string;
  headers: Record<string, string>;
  /** Reads the payload into key → instant. */
  read: (payload: unknown) => Map<string, string>;
  keys: string[];
}

/**
 * One run's lookups: caps, per-source refusal and a per-post cache. A post
 * asked twice in a run is asked once; the answer, a date or "unknown", is
 * kept for the run. Across runs the date is stored on the row, so a dated
 * post is never asked again.
 */
export class PostDateLookup {
  readonly stats: PostDateStats = { requests: zero(), dated: zero(), skipped: zero(), failed: zero() };
  private readonly cache = new Map<string, string | null>();
  private readonly used = zero();
  private readonly refused = new Set<PostDateSource>();
  private readonly fetchImpl: typeof fetch;
  private readonly caps: Record<PostDateSource, number>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: PostDateLookupOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.caps = { ...POST_DATE_CAPS, ...options.caps };
    this.timeoutMs = options.timeoutMs ?? POST_DATE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Dates what it can of `requests`, in the order given: whoever comes first
   * takes a source's cap first. Returns key → ISO instant for the posts it
   * dated; every other key is unknown.
   */
  async dateAll(requests: readonly PostDateRequest[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const pending: PostDateRequest[] = [];
    const queued = new Set<string>();
    for (const request of requests) {
      const key = postDateKey(request);
      if (this.cache.has(key)) {
        const at = this.cache.get(key);
        if (at) out.set(key, at);
        continue;
      }
      if (queued.has(key)) continue;
      queued.add(key);
      pending.push(request);
    }

    // A small pool: CONCURRENCY workers draw the next task until none is left
    // or the time is up; the ones in flight finish.
    const tasks = this.plan(pending);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        if (this.options.signal?.aborted) return;
        if (this.options.deadline !== undefined && Date.now() >= this.options.deadline) return;
        await this.run(tasks[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

    for (const request of pending) {
      const key = postDateKey(request);
      if (!this.cache.has(key)) {
        // Never asked: the cap, a refusal, the deadline.
        this.stats.skipped[request.source] += 1;
        continue;
      }
      const at = this.cache.get(key);
      if (at) out.set(key, at);
    }
    return out;
  }

  /** Requests to send, within each source's cap; Stack Exchange batched per site. */
  private plan(requests: PostDateRequest[]): Task[] {
    const tasks: Task[] = [];
    const take = (source: PostDateSource): boolean => {
      if (this.used[source] >= this.caps[source]) return false;
      this.used[source] += 1;
      return true;
    };
    const json = { Accept: "application/json", "User-Agent": USER_AGENT };

    const bySite = new Map<string, string[]>();
    for (const request of requests) {
      const key = postDateKey(request);
      switch (request.source) {
        case "hackernews":
          if (take("hackernews")) {
            tasks.push({
              source: "hackernews",
              url: `https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(request.id)}.json`,
              headers: json,
              read: (payload) => single(key, parseHackerNewsItem(payload, this.now())),
              keys: [key],
            });
          }
          break;
        case "devto":
          if (take("devto")) {
            tasks.push({
              source: "devto",
              url: `https://dev.to/api/articles/${encodeURIComponent(request.user)}/${encodeURIComponent(request.slug)}`,
              headers: json,
              read: (payload) => single(key, parseDevToArticle(payload, this.now())),
              keys: [key],
            });
          }
          break;
        case "reddit":
          if (take("reddit")) {
            tasks.push({
              source: "reddit",
              url: `https://www.reddit.com/comments/${encodeURIComponent(request.id)}.json?limit=1&raw_json=1`,
              headers: json,
              read: (payload) => single(key, parseRedditPost(payload, request.id, this.now())),
              keys: [key],
            });
          }
          break;
        case "github":
          if (take("github")) {
            const headers: Record<string, string> = {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": USER_AGENT,
            };
            if (this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
            const [owner, repo] = request.repo.split("/");
            tasks.push({
              source: "github",
              url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(request.number)}`,
              headers,
              read: (payload) => single(key, parseGitHubIssue(payload, this.now())),
              keys: [key],
            });
          }
          break;
        case "stackexchange": {
          const site = request.site.toLowerCase();
          const ids = bySite.get(site) ?? [];
          ids.push(request.id);
          bySite.set(site, ids);
          break;
        }
      }
    }

    for (const [site, ids] of bySite) {
      for (let i = 0; i < ids.length; i += STACK_EXCHANGE_BATCH) {
        if (!take("stackexchange")) break;
        const chunk = ids.slice(i, i + STACK_EXCHANGE_BATCH);
        const keys = chunk.map((id) => postDateKey({ source: "stackexchange", site, id }));
        tasks.push({
          source: "stackexchange",
          url: `https://api.stackexchange.com/2.3/questions/${chunk.map(encodeURIComponent).join(";")}?site=${encodeURIComponent(site)}&pagesize=${STACK_EXCHANGE_BATCH}`,
          headers: json,
          read: (payload) => {
            const dates = parseStackExchangeQuestions(payload, this.now());
            return new Map(chunk.flatMap((id, n) => (dates.has(id) ? [[keys[n], dates.get(id) as string] as const] : [])));
          },
          keys,
        });
      }
    }
    return tasks;
  }

  private async run(task: Task): Promise<void> {
    if (this.refused.has(task.source)) return;
    this.stats.requests[task.source] += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
    const parent = this.options.signal;
    const onAbort = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", onAbort, { once: true });
    let dates = new Map<string, string>();
    try {
      const response = await this.fetchImpl(task.url, { headers: task.headers, signal: controller.signal });
      if (response.status === 403 || response.status === 429) throw new Refused(response.status);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      dates = task.read(await response.json());
      if (dates.size < task.keys.length) this.stats.failed[task.source] += 1;
    } catch (err) {
      // A refusal stops the source for the run: asking again is how an
      // address gets banned. Anything else loses this request only.
      if (err instanceof Refused) this.refused.add(task.source);
      this.stats.failed[task.source] += 1;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
    for (const key of task.keys) {
      const at = dates.get(key) ?? null;
      this.cache.set(key, at);
      if (at) this.stats.dated[task.source] += 1;
    }
  }
}

function single(key: string, at: string | null): Map<string, string> {
  return at ? new Map([[key, at]]) : new Map();
}
