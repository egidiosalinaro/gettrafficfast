import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret } from "@/lib/integrations/crypto";
import {
  ingestBusinessSearchConsole,
  SEARCH_CONSOLE,
} from "@/lib/analytics/search-console";
import {
  kickFirstSearchConsoleSync,
  startSearchConsoleIngest,
} from "@/lib/analytics/runs";
import { SEARCH_CONSOLE_INGEST } from "@/lib/jobs/workflows/search-console-ingest";
import { workflowTypes } from "@/lib/jobs/registry";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The first-connect ingest must not invent a watermark. Marking last_synced_on
 * without fetching would shrink the next window to three days and lose the
 * 90-day first pull — which is exactly how "wait until 07:00" used to paper
 * over a missing exceptional sync.
 */

const KEY = "ab".repeat(32);

function connection(over: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    user_id: "user-1",
    business_id: "biz-1",
    provider: SEARCH_CONSOLE,
    site_url: "sc-domain:example.com",
    refresh_token_encrypted: encryptSecret("refresh-token"),
    last_synced_on: null,
    status: "connected",
    ...over,
  };
}

describe("ingestBusinessSearchConsole skip reasons", () => {
  const previous = process.env.INTEGRATIONS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    else process.env.INTEGRATIONS_ENCRYPTION_KEY = previous;
  });

  it("skips a missing connection without writing a watermark", async () => {
    const db = new FakeSupabase({ analytics_connections: [] });
    const result = await ingestBusinessSearchConsole({
      supabase: db as unknown as SupabaseClient,
      businessId: "biz-1",
    });
    expect(result).toEqual({ status: "skipped", reason: "no_connection" });
  });

  it("skips a grant with no property selected without writing a watermark", async () => {
    const db = new FakeSupabase({
      analytics_connections: [connection({ site_url: null })],
    });
    const result = await ingestBusinessSearchConsole({
      supabase: db as unknown as SupabaseClient,
      businessId: "biz-1",
    });
    expect(result).toEqual({ status: "skipped", reason: "no_property" });
    expect(db.tables.analytics_connections[0].last_synced_on).toBeNull();
  });

  it("skips when nothing is published, and leaves last_synced_on null", async () => {
    const db = new FakeSupabase({
      analytics_connections: [connection()],
      articles: [
        {
          id: "art-1",
          business_id: "biz-1",
          status: "generated",
          published_url: "https://example.com/draft",
        },
      ],
    });
    const result = await ingestBusinessSearchConsole({
      supabase: db as unknown as SupabaseClient,
      businessId: "biz-1",
    });
    expect(result).toEqual({ status: "skipped", reason: "no_published_articles" });
    expect(db.tables.analytics_connections[0].last_synced_on).toBeNull();
  });

  it("skips published articles that have no live URL, without a watermark", async () => {
    const db = new FakeSupabase({
      analytics_connections: [connection()],
      articles: [
        {
          id: "art-1",
          business_id: "biz-1",
          status: "published",
          published_url: "  ",
        },
      ],
    });
    const result = await ingestBusinessSearchConsole({
      supabase: db as unknown as SupabaseClient,
      businessId: "biz-1",
    });
    expect(result).toEqual({ status: "skipped", reason: "no_published_articles" });
    expect(db.tables.analytics_connections[0].last_synced_on).toBeNull();
  });
});

describe("kickFirstSearchConsoleSync", () => {
  const previous = process.env.INTEGRATIONS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    else process.env.INTEGRATIONS_ENCRYPTION_KEY = previous;
  });

  it("does not enqueue when the watermark is already the newest settled day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const db = new FakeSupabase({
      analytics_connections: [connection({ last_synced_on: "2026-10-06" })],
      jobs: [],
    });
    const result = await kickFirstSearchConsoleSync({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
    });
    expect(result.skipped).toBe("already_synced");
    expect(result.jobId).toBeNull();
    expect(db.tables.jobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it("enqueues when the watermark is behind the newest settled day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const db = new FakeSupabase({
      analytics_connections: [connection({ last_synced_on: "2026-10-05" })],
      jobs: [],
    });
    const result = await kickFirstSearchConsoleSync({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.jobId).toBeTruthy();
    expect(db.tables.jobs).toHaveLength(1);
    vi.useRealTimers();
  });

  it("enqueues a first ingest when the watermark is missing", async () => {
    const db = new FakeSupabase({
      analytics_connections: [connection()],
      jobs: [],
    });
    const result = await kickFirstSearchConsoleSync({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.jobId).toBeTruthy();
    expect(db.tables.jobs).toHaveLength(1);
    expect(db.tables.jobs[0].type).toBe(SEARCH_CONSOLE_INGEST);
    expect(db.tables.jobs[0].business_id).toBe("biz-1");
  });

  it("does not start a second ingest while one is already pending", async () => {
    const db = new FakeSupabase({
      analytics_connections: [connection()],
      jobs: [
        {
          id: "job-existing",
          user_id: "user-1",
          business_id: "biz-1",
          type: SEARCH_CONSOLE_INGEST,
          status: "pending",
          input: { businessId: "biz-1" },
        },
      ],
    });
    const started = await startSearchConsoleIngest({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
    });
    expect(started.alreadyRunning).toBe(true);
    expect(started.jobId).toBeNull();
    expect(db.tables.jobs).toHaveLength(1);
  });
});

describe("search-console-ingest workflow", () => {
  it("is registered so the worker can run a first-connect job", () => {
    expect(workflowTypes()).toContain(SEARCH_CONSOLE_INGEST);
  });
});
