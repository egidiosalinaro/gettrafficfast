import { canonicalTarget } from "./canonical";
import { retryAfterSecondsFrom } from "@/lib/providers/http";
import { Discussion, DiscoveryProvider, DiscoveryProviderError, DiscoveryQuery } from "./types";
import { SITE_URL } from "@/lib/site";

/**
 * GitHub, over the public REST search API.
 *
 * Answer engines treat GitHub as very high authority, and two kinds of page
 * there are places a business can legitimately be added: an open issue asking
 * for exactly what it does, and an "awesome" list of tools in its category.
 * This provider finds both. It never opens an issue, comments or a pull
 * request: proposing the text is the product's job, submitting it is a
 * person's (docs/PLACEMENTS.md).
 *
 * Free, no key required, but opt-in like every other discovery surface:
 * what it finds is then judged by a paid model call, and a cost must never
 * switch itself on. PLACEMENTS_GITHUB=true enables it; GITHUB_TOKEN enables it
 * too and raises the ceiling. Unauthenticated search is limited to 10 requests
 * a minute per address, so the provider keeps its own sliding window and
 * refuses — with a Retry-After — before GitHub has to.
 */

const API = "https://api.github.com";
const USER_AGENT = `gettrafficfast-discovery (+${SITE_URL})`;
const EXCERPT_LIMIT = 600;

export function isGitHubDiscoveryEnabled(): boolean {
  if (process.env.PLACEMENTS_GITHUB === "false") return false;
  return process.env.PLACEMENTS_GITHUB === "true" || Boolean(process.env.GITHUB_TOKEN);
}

export interface GitHubIssueItem {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  repository_url?: string;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  reactions?: { total_count?: number };
  state?: string;
  pull_request?: unknown;
  locked?: boolean;
}

export interface GitHubRepoItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  owner?: { login?: string } | null;
  archived?: boolean;
  fork?: boolean;
}

export interface GitHubSearchResponse<T> {
  items?: T[];
}

/**
 * Pure mapping from an issue search to discussions. Pull requests come back
 * from the same endpoint and are dropped: a PR is not a question anyone is
 * waiting for an answer to. Locked issues are dropped too: nobody can reply.
 */
export function parseGitHubIssues(payload: GitHubSearchResponse<GitHubIssueItem>): Discussion[] {
  return (payload.items ?? [])
    .map((item): Discussion | null => {
      if (!item.html_url || !item.title || item.pull_request || item.locked) return null;
      const canonical = canonicalTarget(item.html_url);
      if (!canonical || canonical.surface !== "github") return null;
      return {
        externalId: canonical.externalId,
        surface: "github",
        kind: "issue",
        url: canonical.url,
        title: item.title.trim(),
        excerpt: (item.body ?? "").replace(/\r/g, "").trim().slice(0, EXCERPT_LIMIT),
        community: canonical.community,
        author: item.user?.login?.trim() || null,
        createdAt: item.created_at ?? null,
        score: item.reactions?.total_count ?? 0,
        commentCount: item.comments ?? 0,
      };
    })
    .filter((d): d is Discussion => d !== null);
}

/**
 * Pure mapping from a repository search to discussions. Archived repositories
 * and forks are dropped: a list nobody maintains cannot take an addition, and
 * a fork is not where the list lives. `createdAt` carries the last push, which
 * is the freshness signal that matters for a list.
 */
export function parseGitHubRepos(payload: GitHubSearchResponse<GitHubRepoItem>): Discussion[] {
  return (payload.items ?? [])
    .map((item): Discussion | null => {
      if (!item.html_url || !item.full_name || item.archived || item.fork) return null;
      const canonical = canonicalTarget(item.html_url);
      if (!canonical || canonical.surface !== "github") return null;
      return {
        externalId: canonical.externalId,
        surface: "github",
        kind: "repository",
        url: canonical.url,
        title: item.full_name.trim(),
        excerpt: (item.description ?? "").trim().slice(0, EXCERPT_LIMIT),
        community: canonical.community,
        author: item.owner?.login?.trim() || null,
        createdAt: item.pushed_at ?? null,
        score: item.stargazers_count ?? 0,
        commentCount: null,
      };
    })
    .filter((d): d is Discussion => d !== null);
}

/** Sliding one-minute window, so the provider refuses before GitHub does. */
class RequestWindow {
  private readonly stamps: number[] = [];
  constructor(private readonly limit: number) {}

  take(now = Date.now()): number | null {
    while (this.stamps.length && this.stamps[0] <= now - 60_000) this.stamps.shift();
    if (this.stamps.length >= this.limit) {
      return Math.max(1, Math.ceil((this.stamps[0] + 60_000 - now) / 1000));
    }
    this.stamps.push(now);
    return null;
  }
}

export class GitHubDiscoveryProvider implements DiscoveryProvider {
  readonly name = "github";
  private readonly window: RequestWindow;

  constructor(private readonly token: string | null = null) {
    // Two below GitHub's own ceilings, so a second worker on the same address
    // has a little room.
    this.window = new RequestWindow(token ? 28 : 8);
  }

  private async get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const wait = this.window.take();
    if (wait !== null) {
      throw new DiscoveryProviderError(
        `GitHub search budget for this minute is used up; retry in ${wait}s`,
        this.name,
        undefined,
        { status: 429, retryAfterSeconds: wait }
      );
    }

    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await fetch(url, { headers, signal: signal ?? null });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const retryAfterSeconds =
        retryAfterSecondsFrom(response.headers.get("retry-after")) ??
        (Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : undefined);
      throw new DiscoveryProviderError(
        `GitHub search failed (${response.status}): ${body.slice(0, 200)}`,
        this.name,
        undefined,
        { status: response.status, retryAfterSeconds }
      );
    }
    return (await response.json()) as T;
  }

  async search(query: DiscoveryQuery): Promise<Discussion[]> {
    const perPage = String(Math.min(query.limit ?? 10, 30));
    const now = new Date();
    const cutoff = query.maxAgeDays ? now.getTime() - query.maxAgeDays * 86_400_000 : null;

    const issues = await this.get<GitHubSearchResponse<GitHubIssueItem>>(
      "/search/issues",
      {
        q: `${query.query} is:issue is:open`,
        sort: "updated",
        order: "desc",
        per_page: perPage,
        advanced_search: "true",
      },
      query.signal
    );
    // Age is judged on activity, not creation: an issue opened a year ago and
    // answered last week is alive.
    const liveIssues = (issues.items ?? []).filter((item) => {
      if (!cutoff) return true;
      const at = new Date(item.updated_at ?? item.created_at ?? 0).getTime();
      return Number.isFinite(at) && at >= cutoff;
    });

    const repos = await this.get<GitHubSearchResponse<GitHubRepoItem>>(
      "/search/repositories",
      {
        q: `${query.query} awesome in:name,description,readme`,
        sort: "stars",
        order: "desc",
        per_page: perPage,
      },
      query.signal
    );

    return [...parseGitHubIssues({ items: liveIssues }), ...parseGitHubRepos(repos)];
  }
}
