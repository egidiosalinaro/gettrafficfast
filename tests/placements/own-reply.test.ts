import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditDraft } from "@/lib/placements/audit";
import { OWN_REPLY_VARIANT, draftAuditContext, saveOwnReply } from "@/lib/placements/own-reply";
import { HUMAN_WRITTEN_AGENT_VERSION, bestAuditStatus, isHumanWritten } from "@/lib/placements/workflow";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Write your own". What is pinned: the person's text is stored as their own
 * draft (short_comment, agent_version 0) and judged by the same gate as any
 * draft, with nothing placed in it; reads go through the person's client and
 * only the row is written by the service role; a second save replaces the
 * first; the post moves to drafted or needs review like a drafted one; and a
 * post that is not theirs, or is closed, takes nothing.
 */

const USER = "user-1";
const BUSINESS = "biz-1";
const TARGET = "target-1";
const NOW = new Date("2026-11-08T10:00:00.000Z");

const seed = (over: { status?: string; user_id?: string } = {}) =>
  new FakeSupabase({
    placement_targets: [
      {
        id: TARGET,
        user_id: over.user_id ?? USER,
        business_id: BUSINESS,
        surface: "x",
        kind: "post",
        title: "How do you get cited by ChatGPT?",
        excerpt: "Our SEO is fine but ChatGPT never mentions us.",
        status: over.status ?? "qualified",
        qualify_angle: null,
      },
    ],
    businesses: [
      {
        id: BUSINESS,
        user_id: USER,
        name: "Acme",
        website_url: "https://acme.test",
        aeo_settings: {},
        voice_settings: { aboutYou: "I run Acme's content." },
      },
    ],
    keywords: [{ business_id: BUSINESS, keyword: "ai seo" }],
    entities: [],
    placements: [],
  });

describe("saveOwnReply", () => {
  let db: FakeSupabase;
  let userTables: string[];
  let adminTables: string[];

  const clients = () => ({
    supabase: {
      from: (table: string) => {
        userTables.push(table);
        return db.from(table);
      },
    } as unknown as SupabaseClient,
    admin: {
      from: (table: string) => {
        adminTables.push(table);
        return db.from(table);
      },
    } as unknown as SupabaseClient,
  });

  beforeEach(() => {
    userTables = [];
    adminTables = [];
  });

  const save = (body: string) =>
    saveOwnReply({ ...clients(), userId: USER, businessId: BUSINESS, targetId: TARGET, body, now: NOW });

  it("stores the person's text as their own short reply, audited by the same gate", async () => {
    db = seed();
    const body = "ChatGPT never mentions a site whose SEO is fine but whose pages bury the answer: to get cited, put the direct answer first.";
    const result = await save(`  ${body}  `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = db.tables.placements;
    expect(rows).toHaveLength(1);
    const expected = auditDraft(
      { variant: OWN_REPLY_VARIANT, body, linkUrl: null, claims: [] },
      draftAuditContext({
        target: db.tables.placement_targets[0],
        business: db.tables.businesses[0],
        keywords: db.tables.keywords,
        entities: [],
      })
    );
    expect(rows[0]).toMatchObject({
      user_id: USER,
      business_id: BUSINESS,
      target_id: TARGET,
      variant: "short_comment",
      body,
      link_url: null,
      claims: [],
      agent_version: HUMAN_WRITTEN_AGENT_VERSION,
      audit_status: expected.status,
    });
    expect(rows[0].audit).toEqual(expected);
    expect(result.draft.body).toBe(body);
    expect(isHumanWritten(result.draft)).toBe(true);
    // Reads as the person; only the row goes through the service role.
    expect(adminTables.every((t) => t === "placements")).toBe(true);
    expect(userTables).toContain("placement_targets");
  });

  it("moves the post like a drafted one: drafted when it passes, needs review when blocked", async () => {
    db = seed();
    const passed = await save("ChatGPT never mentions a site whose SEO is fine but whose pages bury the answer: to get cited, put the direct answer first.");
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.draft.auditStatus).not.toBe("blocked");
    expect(passed.targetStatus).toBe("drafted");
    expect(db.tables.placement_targets[0].status).toBe("drafted");

    db = seed();
    const blocked = await save("Check out Acme at https://acme.test, the best tool for this!");
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.draft.auditStatus).toBe("blocked");
    expect(blocked.targetStatus).toBe("needs_review");
    expect(db.tables.placement_targets[0].status).toBe("needs_review");
  });

  it("replaces an earlier own reply and keeps the drafting job's rows", async () => {
    db = seed({ status: "drafted" });
    db.tables.placements.push({
      id: "agent-draft",
      target_id: TARGET,
      business_id: BUSINESS,
      user_id: USER,
      variant: "short_comment",
      body: "Written by the agent.",
      audit_status: "passed",
      agent_version: 15,
    });
    await save("First version of my reply, answering the question directly.");
    await save("Second version of my reply, answering the question directly.");
    const own = db.tables.placements.filter((r) => r.agent_version === HUMAN_WRITTEN_AGENT_VERSION);
    expect(own).toHaveLength(1);
    expect(own[0].body).toBe("Second version of my reply, answering the question directly.");
    expect(db.tables.placements.some((r) => r.id === "agent-draft")).toBe(true);
    // One draft already passed: the post stays drafted whatever the own reply scored.
    expect(db.tables.placement_targets[0].status).toBe("drafted");
  });

  it("leaves an approved post where the person put it", async () => {
    db = seed({ status: "approved" });
    const result = await save("A reply written on an approved post, answering the question.");
    expect(result.ok && result.targetStatus).toBe("approved");
    expect(db.tables.placement_targets[0].status).toBe("approved");
  });

  it("refuses an empty text, a closed post and a post that is not the person's, writing nothing", async () => {
    db = seed();
    expect(await save("   ")).toMatchObject({ ok: false, status: 400 });

    db = seed({ status: "published_manually" });
    expect(await save("A reply to a post already answered.")).toMatchObject({ ok: false, status: 409 });

    db = seed({ user_id: "someone-else" });
    expect(await save("A reply to someone else's post.")).toMatchObject({ ok: false, status: 404 });

    expect(adminTables).toEqual([]);
    expect(db.tables.placements).toEqual([]);
  });
});

describe("bestAuditStatus", () => {
  it("is the best verdict among the drafts", () => {
    expect(bestAuditStatus(["blocked", "passed"])).toBe("passed");
    expect(bestAuditStatus(["blocked", "warning"])).toBe("warning");
    expect(bestAuditStatus(["blocked"])).toBe("blocked");
    expect(bestAuditStatus([])).toBe("blocked");
  });
});
