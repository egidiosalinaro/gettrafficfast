import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The action route and the reply's text. What is pinned: once a link to the
 * person's reply is saved (`set_published_url`, or `mark_published` carrying
 * one), its text is read back from X after the answer, through `after`; an
 * action without a link schedules nothing; an oEmbed that fails, or a
 * read-back that cannot even be scheduled, never touches the person's
 * action, which has already succeeded; and the action's own update never
 * names the new columns, so it works on a database without the migration.
 */

const THREAD = "https://x.com/janedoe/status/1855000000000000000";
const REPLY = "https://x.com/owner/status/1855000000000000001";

const routeMocks = vi.hoisted(() => ({
  db: null as unknown as { from: (table: string) => unknown },
  afterTasks: [] as Array<() => unknown>,
  afterThrows: false,
  readXPost: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      if (routeMocks.afterThrows) throw new Error("`after` was called outside a request scope.");
      routeMocks.afterTasks.push(task);
    },
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => routeMocks.db.from(table),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => routeMocks.db }));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site", code: "no_business" },
  selectedBusinessId: async () => "biz-1",
}));
vi.mock("@/lib/providers/x/oembed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/x/oembed")>()),
  readXPost: (...args: unknown[]) => routeMocks.readXPost(...args),
}));

function seed(overrides: Record<string, unknown> = {}) {
  const db = new FakeSupabase({
    placement_targets: [
      {
        id: "t-1",
        business_id: "biz-1",
        user_id: "user-1",
        surface: "x",
        kind: "post",
        url: THREAD,
        title: "A post",
        author: "janedoe",
        status: "published_manually",
        published_url: null,
        published_text: null,
        published_text_at: null,
        created_at: "2026-11-09T09:00:00.000Z",
        ...overrides,
      },
    ],
  });
  routeMocks.db = db;
  return db;
}

async function call(body: unknown) {
  const { POST } = await import("@/app/api/placements/[id]/action/route");
  const request = new Request("https://gettrafficfa.st/api/placements/t-1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request as never, { params: Promise.resolve({ id: "t-1" }) });
}

/** What Next does once the response has gone. */
const runAfterTasks = () => Promise.all(routeMocks.afterTasks.map((task) => task()));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  routeMocks.afterTasks = [];
  routeMocks.afterThrows = false;
  routeMocks.readXPost.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("POST /api/placements/:id/action, the reply's text", () => {
  it("reads the reply back from X after saving its link", async () => {
    const db = seed();
    routeMocks.readXPost.mockResolvedValue({
      text: "@janedoe What I actually posted, edited on X.",
      authorName: "Owner",
      handle: "owner",
      postedOn: null,
    });

    const response = await call({ action: "set_published_url", publishedUrl: REPLY });
    expect(response.status).toBe(200);
    expect((await response.json()).target).toMatchObject({ publishedUrl: REPLY });
    // Nothing was read before the answer went out.
    expect(routeMocks.readXPost).not.toHaveBeenCalled();
    expect(routeMocks.afterTasks).toHaveLength(1);

    await runAfterTasks();
    expect(routeMocks.readXPost).toHaveBeenCalledWith(REPLY, expect.objectContaining({ timeoutMs: 6_000 }));
    expect(db.tables.placement_targets[0]).toMatchObject({
      published_url: REPLY,
      published_text: "What I actually posted, edited on X.",
    });
  });

  it("reads it back when I posted it carries a link, and schedules nothing without one", async () => {
    let db = seed({ status: "drafted" });
    routeMocks.readXPost.mockResolvedValue({ text: "Posted with the link.", authorName: null, handle: "owner", postedOn: null });
    expect((await call({ action: "mark_published", publishedUrl: REPLY })).status).toBe(200);
    await runAfterTasks();
    expect(db.tables.placement_targets[0].published_text).toBe("Posted with the link.");

    routeMocks.afterTasks = [];
    routeMocks.readXPost.mockClear();
    db = seed({ status: "drafted" });
    expect((await call({ action: "mark_published" })).status).toBe(200);
    expect(routeMocks.afterTasks).toEqual([]);
    expect(db.tables.placement_targets[0]).toMatchObject({ status: "published_manually", published_text: null });

    expect((await call({ action: "set_published_url", publishedUrl: "not a link" })).status).toBe(400);
    expect(routeMocks.afterTasks).toEqual([]);
  });

  it("skips a link that is not on X without asking X", async () => {
    const db = seed({ surface: "reddit", url: "https://www.reddit.com/r/seo/comments/abc/title/" });
    const response = await call({
      action: "set_published_url",
      publishedUrl: "https://www.reddit.com/r/seo/comments/abc/title/def/",
    });
    expect(response.status).toBe(200);
    await runAfterTasks();
    expect(routeMocks.readXPost).not.toHaveBeenCalled();
    expect(db.tables.placement_targets[0].published_text).toBeNull();
  });

  it("still succeeds when X fails, and leaves the text unread", async () => {
    const db = seed();
    routeMocks.readXPost.mockResolvedValue(null);
    const response = await call({ action: "set_published_url", publishedUrl: REPLY });
    expect(response.status).toBe(200);
    expect((await response.json()).target.publishedUrl).toBe(REPLY);
    await expect(runAfterTasks()).resolves.toBeDefined();
    expect(db.tables.placement_targets[0]).toMatchObject({ published_url: REPLY, published_text: null });

    // Even a reader that throws, or an `after` that cannot schedule, leaves the action done.
    routeMocks.afterTasks = [];
    routeMocks.readXPost.mockRejectedValue(new Error("boom"));
    expect((await call({ action: "set_published_url", publishedUrl: REPLY })).status).toBe(200);
    await expect(runAfterTasks()).resolves.toBeDefined();

    routeMocks.afterThrows = true;
    expect((await call({ action: "set_published_url", publishedUrl: REPLY })).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("placements.published_text_not_scheduled"));
  });

  it("saves the link on a database that does not have the text columns yet", async () => {
    const db = seed();
    const row = db.tables.placement_targets[0];
    delete row.published_text;
    delete row.published_text_at;
    routeMocks.readXPost.mockResolvedValue(null);
    const response = await call({ action: "set_published_url", publishedUrl: REPLY });
    expect(response.status).toBe(200);
    expect(row.published_url).toBe(REPLY);
    expect(row).not.toHaveProperty("published_text");
    expect((await response.json()).target).not.toHaveProperty("publishedText");
  });

  it("accepts It was removed on a posted row, with an optional reason, and its Undo", async () => {
    const db = seed({ surface: "reddit", url: "https://www.reddit.com/r/seo/comments/abc/title/" });
    const response = await call({ action: "mark_removed", reason: "Hidden because my account is new" });
    expect(response.status).toBe(200);
    const { target } = await response.json();
    expect(target).toMatchObject({ status: "published_manually", removedReason: "Hidden because my account is new" });
    expect(typeof target.removedAt).toBe("string");
    expect(db.tables.placement_targets[0]).toMatchObject({ status: "published_manually", published_url: null });
    expect(routeMocks.afterTasks).toEqual([]);

    // The body's own limit, then the Undo.
    expect((await call({ action: "mark_removed", reason: "x".repeat(301) })).status).toBe(400);
    const undone = await call({ action: "unmark_removed" });
    expect(undone.status).toBe(200);
    expect((await undone.json()).target).toMatchObject({ removedAt: null, removedReason: null });
  });

  it("refuses It was removed on a row that was not posted", async () => {
    seed({ status: "drafted" });
    const response = await call({ action: "mark_removed" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("Only a reply you marked as posted can be marked as removed.");
  });

  it("clears the text read from the old link when the link changes", async () => {
    const db = seed({
      published_url: "https://x.com/owner/status/1855000000000000099",
      published_text: "The wrong reply.",
      published_text_at: "2026-11-09T08:00:00.000Z",
    });
    routeMocks.readXPost.mockResolvedValue(null);
    expect((await call({ action: "set_published_url", publishedUrl: REPLY })).status).toBe(200);
    // The action's own update names no new column; the clearing comes after.
    expect(db.tables.placement_targets[0]).toMatchObject({ published_url: REPLY, published_text: "The wrong reply." });
    await runAfterTasks();
    expect(db.tables.placement_targets[0]).toMatchObject({ published_url: REPLY, published_text: null, published_text_at: null });
  });
});
