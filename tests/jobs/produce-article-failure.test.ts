import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_SUBSCRIPTION_INACTIVE_MESSAGE, type JobRow } from "@/lib/jobs/types";
import { customerReason, produceArticleWorkflow } from "@/lib/jobs/workflows/produce-article";
import { LLM_PAUSED_MESSAGE } from "@/lib/llm-billing";
import { spendHeldMessage } from "@/lib/limits/spend";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * What the customer hears when production stops. A provider that cannot pay
 * or did not answer only delays the article: no email, back to the queue.
 * Anything else is a failure, emailed with the real attempt count and a
 * sentence of ours, never the vendor's message.
 */

const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }));
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  sendNotificationEmail: async (input: { to: string; subject: string; html: string }) => {
    emails.sent.push(input);
    return true;
  },
}));

function job(attempts: number): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "produce-article",
    input: { articleId: "article-1" },
    status: "running",
    current_step: "write",
    attempts,
    max_attempts: 3,
    last_error: null,
  };
}

describe("produce-article when production stops", () => {
  let db: FakeSupabase;
  const supabase = () => db as unknown as SupabaseClient;

  beforeEach(() => {
    emails.sent.length = 0;
    db = new FakeSupabase({
      articles: [
        {
          id: "article-1",
          user_id: "user-1",
          business_id: null,
          keyword_id: "kw-1",
          scheduled_date: "2026-11-08",
          status: "generating",
          attempt_count: 0,
          keywords: { keyword: "answer engine optimization" },
        },
      ],
      article_events: [],
    });
    (db.auth.admin as { getUserById: unknown }).getUserById = async () => ({
      data: { user: { email: "owner@example.test" } },
      error: null,
    });
  });

  it("sends no email for an account that cannot pay, and puts the article back in the queue", async () => {
    const vendor =
      "Claude refused the call because the account cannot pay: [400 invalid_request_error] Your credit balance is too low";
    await produceArticleWorkflow.onFailure!({ job: job(1), supabase: supabase(), error: vendor, outputs: {} });

    expect(emails.sent).toHaveLength(0);
    const article = db.tables.articles[0];
    expect(article.status).toBe("queued");
    expect(article.attempt_count).toBe(0);
  });

  it("sends no email when the provider did not answer", async () => {
    await produceArticleWorkflow.onFailure!({
      job: job(3),
      supabase: supabase(),
      error: "Gemini did not answer in time. The fallback failed too: Claude did not answer in time.",
      outputs: {},
    });
    expect(emails.sent).toHaveLength(0);
    expect(db.tables.articles[0].status).toBe("queued");
  });

  it("sends no email when the worker stopped the job for an inactive subscription, and requeues the article", async () => {
    await produceArticleWorkflow.onFailure!({
      job: job(1),
      supabase: supabase(),
      error: JOB_SUBSCRIPTION_INACTIVE_MESSAGE,
      outputs: {},
    });
    expect(emails.sent).toHaveLength(0);
    const article = db.tables.articles[0];
    expect(article.status).toBe("queued");
    expect(article.attempt_count).toBe(0);
    expect(article.last_error).toBe(JOB_SUBSCRIPTION_INACTIVE_MESSAGE);
  });

  it("emails any other failure with the real attempt count and without the raw error", async () => {
    const error = "The generated article failed validation: thin_content";
    await produceArticleWorkflow.onFailure!({ job: job(1), supabase: supabase(), error, outputs: {} });

    expect(db.tables.articles[0].status).toBe("failed");
    expect(emails.sent).toHaveLength(1);
    const html = emails.sent[0].html;
    expect(html).toContain("after 1 attempt ");
    expect(html).not.toContain("3 attempts");
    expect(html).not.toContain("thin_content");
    expect(html).toContain(customerReason(error));
  });

  it("states three attempts when there were three", async () => {
    await produceArticleWorkflow.onFailure!({ job: job(3), supabase: supabase(), error: "boom", outputs: {} });
    expect(emails.sent[0].html).toContain("after 3 attempts");
    expect(emails.sent[0].html).not.toContain("boom");
  });

  it("returns a generating article to the queue when the billing pause holds its job", async () => {
    await produceArticleWorkflow.onPause!({ job: job(1), supabase: supabase(), outputs: { outline: {} } });
    expect(db.tables.articles[0].status).toBe("queued");
    expect(db.tables.articles[0].last_error).toContain("credits are depleted");
    expect(emails.sent).toHaveLength(0);
    // The job's own sentence reads as billing too, so every surface says "delayed".
    expect(LLM_PAUSED_MESSAGE).toContain("credits are depleted");
  });

  it("returns a generating article to the queue with the spend limit as its cause when the limit holds its job", async () => {
    const reason = spendHeldMessage(new Date("2026-11-15T14:05:00.000Z"));
    expect(reason).toBe("Waiting: today's limit for AI work is reached. This resumes on its own at about 14:05 UTC on Nov 15.");
    await produceArticleWorkflow.onPause!({ job: job(1), supabase: supabase(), outputs: { outline: {} }, reason });
    expect(db.tables.articles[0].status).toBe("queued");
    expect(db.tables.articles[0].last_error).toBe(reason);
    expect(db.tables.articles[0].attempt_count).toBe(0);
    expect(emails.sent).toHaveLength(0);
  });

  it("leaves a validated article alone when the pause holds the enrichment", async () => {
    db.tables.articles[0].status = "generated";
    await produceArticleWorkflow.onPause!({ job: job(1), supabase: supabase(), outputs: { validate: {} } });
    expect(db.tables.articles[0].status).toBe("generated");
  });
});
