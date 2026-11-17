import { vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import type { XAccount, XApiClient, XApiPost, XCallResult, XUserLookupResult } from "@/lib/providers/x/api";

type Row = Record<string, unknown>;

/**
 * The in-memory database with the two ledger functions of migration
 * 20261111120000 implemented as the SQL does: a reservation is refused when
 * the month's spend plus the amount would cross the cap; a settle moves the
 * month by the adjustment, never below zero, and counts the call.
 */
export class LedgerFake extends FakeSupabase {
  /** Set to make every rpc fail, as a missing function would. */
  rpcError: string | null = null;

  constructor(seed: Record<string, Row[]> = {}) {
    super({ provider_spend: [], provider_pauses: [], operator_alerts: [], ...seed });
  }

  private ledgerRow(provider: string, month: string): Row {
    let row = this.tables.provider_spend.find((r) => r.provider === provider && r.month === month);
    if (!row) {
      row = { provider, month, cost_usd: 0, calls: 0, posts: 0 };
      this.tables.provider_spend.push(row);
    }
    return row;
  }

  // @ts-expect-error the base fake's rpc takes no arguments; this one reads them.
  rpc(name: string, args: Record<string, unknown>) {
    if (this.rpcError) return Promise.resolve({ data: null, error: { message: this.rpcError } });
    const row = this.ledgerRow(args.p_provider as string, args.p_month as string);
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    if (name === "reserve_provider_spend") {
      const next = round(Number(row.cost_usd) + Number(args.p_amount));
      if (next > Number(args.p_cap)) return Promise.resolve({ data: null, error: null });
      row.cost_usd = next;
      return Promise.resolve({ data: next, error: null });
    }
    if (name === "settle_provider_spend") {
      row.cost_usd = Math.max(0, round(Number(row.cost_usd) + Number(args.p_adjust)));
      row.calls = Number(row.calls) + Number(args.p_calls);
      row.posts = Number(row.posts) + Number(args.p_posts);
      return Promise.resolve({ data: row.cost_usd, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown function ${name}` } });
  }

  spend(month: string, provider = "x-api"): Row | undefined {
    return this.tables.provider_spend.find((r) => r.provider === provider && r.month === month);
  }
}

export function xPost(id: string, over: Partial<XApiPost> = {}): XApiPost {
  return {
    id,
    text: `How do I get my SaaS cited in AI answers? post ${id}`,
    authorId: `u${id}`,
    handle: `author${id}`,
    authorName: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    lang: "en",
    metrics: { impressions: null, likes: 4, replies: 2, reposts: null, quotes: null, bookmarks: null },
    media: [],
    mediaUndescribed: 0,
    ...over,
  };
}

const result = (posts: XApiPost[], unit = 0.005): XCallResult => ({
  posts,
  missingIds: [],
  billedPosts: posts.length,
  costUsd: Math.round(posts.length * unit * 10_000) / 10_000,
});

export function xAccount(handle: string, over: Partial<XAccount["metrics"]> = {}): XAccount {
  return { id: `id-${handle}`, handle, metrics: { followers: 1200, following: 300, posts: 5000, listed: 4, ...over } };
}

/**
 * A stand-in for the X client: each search answers the next batch; lookups
 * answer what they are given; a user lookup answers `user(handle)`, an
 * account named after the handle by default.
 */
export function fakeXClient(
  options: { searches?: XApiPost[][]; lookup?: (ids: string[]) => XCallResult; user?: (handle: string) => XAccount | null } = {}
) {
  const searches = [...(options.searches ?? [])];
  const searchRecent = vi.fn(async () => result(searches.shift() ?? []));
  const lookup = vi.fn(async (ids: string[]) => (options.lookup ? options.lookup(ids) : result([])));
  const userByUsername = vi.fn(async (handle: string): Promise<XUserLookupResult> => {
    const account = options.user ? options.user(handle) : xAccount(handle);
    return { account, billedPosts: account ? 1 : 0, costUsd: account ? 0.01 : 0 };
  });
  return { client: { searchRecent, lookup, userByUsername } as unknown as XApiClient, searchRecent, lookup, userByUsername };
}
