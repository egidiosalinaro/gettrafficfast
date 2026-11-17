/**
 * Transactional notification emails, sent through the Resend REST API.
 *
 * Sending is best-effort and never throws: a notification failure must not
 * break the cron. If RESEND_API_KEY is missing the send is skipped with a log
 * line, so the app works without email configured.
 *
 * Env:
 *   RESEND_API_KEY            - Resend API key (sending access is enough)
 *   NOTIFICATIONS_FROM_EMAIL  - optional From override; must be on a domain
 *                               verified in the Resend account.
 *   OPERATOR_EMAIL            - optional; where operator alerts go (LLM
 *                               billing). Defaults to CONTACT_EMAIL.
 */

import { CONTACT_EMAIL, SITE_HOST, SITE_URL } from "@/lib/site";

const DEFAULT_FROM = `GetTrafficFast <notifications@${SITE_HOST}>`;
const APP_URL = SITE_URL;

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export async function sendNotificationEmail({
  to,
  subject,
  html,
}: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      JSON.stringify({
        level: "warn",
        job: "notifications",
        skipped: "RESEND_API_KEY not set",
        subject,
      })
    );
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.NOTIFICATIONS_FROM_EMAIL || DEFAULT_FROM,
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        JSON.stringify({
          level: "error",
          job: "notifications",
          status: res.status,
          body: body.slice(0, 500),
          subject,
        })
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        job: "notifications",
        error: err instanceof Error ? err.message : String(err),
        subject,
      })
    );
    return false;
  }
}

function layout(title: string, bodyHtml: string): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 16px">${title}</h2>
    ${bodyHtml}
    <p style="margin-top:32px;font-size:12px;color:#888">
      You are receiving this because you have scheduled articles on
      <a href="${APP_URL}" style="color:#888">GetTrafficFast</a>.
    </p>
  </div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The article ran out of attempts for a reason the customer can act on or at
 * least understand. Never sent for a provider that cannot pay or did not
 * answer: that article is only delayed, and it says so on its card
 * (`docs/AGENT_RUNTIME.md`). `reason` is a sentence written for the person,
 * never the vendor's or the code's own message, which stays in
 * `articles.last_error` for diagnosis.
 */
export function articleFailedEmail(keyword: string, attempts: number, reason: string) {
  const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  return {
    subject: `Article generation failed: "${keyword}"`,
    html: layout(
      "An article could not be generated",
      `<p>The scheduled article for the keyword <strong>${escapeHtml(keyword)}</strong>
       could not be generated after ${tries} and has been paused.</p>
       <p>${escapeHtml(reason)}</p>
       <p>You can re-queue it from the
       <a href="${APP_URL}/content/articles">articles</a> — open the article card and
       click <strong>Re-queue</strong>.</p>`
    ),
  };
}

/**
 * Where operator alerts go: OPERATOR_EMAIL when set, otherwise the one inbox
 * a human reads (`CONTACT_EMAIL`). Returns null only when both are empty.
 */
export function operatorEmailAddress(): string | null {
  const configured = process.env.OPERATOR_EMAIL?.trim();
  return configured || CONTACT_EMAIL || null;
}

/** To the operator, never a customer: the model accounts cannot pay. */
export function llmBillingAlertEmail(input: {
  providers: readonly string[];
  detail: string;
  pausedUntil: Date;
  source: string;
}) {
  const names = input.providers.join(" and ");
  return {
    subject: `[GetTrafficFast] LLM billing refused (${names}): generation is paused`,
    html: `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 16px">The model accounts cannot pay</h2>
    <p>Every LLM provider asked (<strong>${escapeHtml(names)}</strong>) refused the call
       because its account cannot pay. Top up billing to resume.</p>
    <ul style="padding-left:20px;line-height:1.7">
      <li>LLM-bound jobs stay queued and spend no attempt.</li>
      <li>Crons skip enqueueing LLM work and paid lookups that feed it.</li>
      <li>Customers are not emailed: their articles are delayed, not failed.</li>
      <li>Paused until ${escapeHtml(input.pausedUntil.toISOString())}, then the next run tries again
          and pauses again if the account still cannot pay.</li>
    </ul>
    <p style="font-size:13px;color:#555">First seen by: ${escapeHtml(input.source)}</p>
    <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#991b1b">
      ${escapeHtml(input.detail.slice(0, 1000))}
    </p>
    <p style="font-size:12px;color:#888">One email per UTC day. Sentry carries one fatal event per
       provider per day (fingerprint <code>llm-billing</code>).</p>
  </div>`,
  };
}

const BUTTON_STYLE =
  "display:inline-block;background:#171717;color:#fafafa;text-decoration:none;" +
  "padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600";

export function welcomeEmail() {
  return {
    subject: "Welcome to GetTrafficFast — let's put your SEO on autopilot",
    html: layout(
      "Welcome aboard 👋",
      `<p>GetTrafficFast researches, writes and publishes for your site, then
       measures whether Google ranks it and whether answer engines cite it.
       Three steps and the loop can run:</p>
       <ol style="padding-left:20px;line-height:1.8">
         <li><strong>Add your business</strong> — we analyze your website to
             understand your niche.</li>
         <li><strong>Generate keywords</strong> — the agent proposes queries;
             an article is an output of that list, never the starting point.</li>
         <li><strong>Connect your site</strong> — WordPress or a webhook, so
             finished articles go live on <em>your</em> domain.</li>
       </ol>
       <p>After that, Home is the operating loop (research, plan, produce,
       publish, measure). The calendar is the production board, one article
       a day.</p>
       <p style="margin-top:24px">
         <a href="${APP_URL}/settings/business" style="${BUTTON_STYLE}">
           Set up your business →
         </a>
       </p>
       <p style="font-size:13px;color:#555">It takes about 2 minutes — the
       better we know your business, the better your articles rank.</p>`
    ),
  };
}

export function onboardingNudgeEmail() {
  return {
    subject: "Your SEO autopilot isn't running yet",
    html: layout(
      "One step left to start ranking",
      `<p>You created your GetTrafficFast account a few days ago, but your
       business isn't set up yet — so no keywords are being targeted and no
       articles are being written for you.</p>
       <p>It takes about 2 minutes: paste your website URL, we analyze it, and
       the daily article engine can start working for your domain.</p>
       <p style="margin-top:24px">
         <a href="${APP_URL}/settings/business" style="${BUTTON_STYLE}">
           Finish setup →
         </a>
       </p>
       <p style="font-size:13px;color:#555">Questions? Just reply to this
       email.</p>`
    ),
  };
}

export function articleNeedsReviewEmail(keyword: string, reasons: string[]) {
  const list = reasons.length
    ? `<ul style="padding-left:20px;line-height:1.7">${reasons
        .map((r) => `<li>${escapeHtml(r)}</li>`)
        .join("")}</ul>`
    : "";
  return {
    subject: `Needs review before publishing: "${keyword}"`,
    html: layout(
      "An article is waiting for your approval",
      `<p>The article for <strong>${escapeHtml(keyword)}</strong> was written, but our
       quality checks flagged something, so it was <strong>not</strong> published to
       your site.</p>
       ${list}
       <p>The content is safe and nothing was lost. Open the article from your
       <a href="${APP_URL}/content/articles">articles</a> to review it, then publish it
       yourself or send it back for regeneration.</p>
       <p style="font-size:13px;color:#555">We would rather miss a publication
       than put broken content on your domain.</p>`
    ),
  };
}

/**
 * Pages Google is not indexing: a published article still out of the index a
 * week after it went live, or a page that was indexed and dropped out. One
 * email per sweep for a site, each URL listed once per state (the caller
 * dedupes on notification_log). Google's reason is quoted in its own words.
 */
export function indexingAlertEmail(
  siteLabel: string,
  alerts: ReadonlyArray<{
    url: string;
    kind: "not_indexed_after_publish" | "dropped_from_index";
    coverageState: string | null;
    inspectionResultLink: string | null;
  }>
) {
  const items = alerts
    .map((alert) => {
      const why = alert.coverageState ?? "Google gave no reason";
      const what = alert.kind === "dropped_from_index" ? "was indexed, now is not" : "not indexed a week after publishing";
      const report = alert.inspectionResultLink
        ? ` (<a href="${escapeHtml(alert.inspectionResultLink)}">Google's report</a>)`
        : "";
      return `<li><a href="${escapeHtml(alert.url)}">${escapeHtml(alert.url)}</a>: ${escapeHtml(what)}.
        Google says: <strong>${escapeHtml(why)}</strong>${report}</li>`;
    })
    .join("");
  const count = alerts.length === 1 ? "A page" : `${alerts.length} pages`;
  return {
    subject: `${count} on ${siteLabel} ${alerts.length === 1 ? "is" : "are"} not on Google`,
    html: layout(
      "Google is not indexing these pages",
      `<p>Google's URL Inspection says these pages of <strong>${escapeHtml(siteLabel)}</strong>
       are not in its index:</p>
       <ul style="padding-left:20px;line-height:1.7">${items}</ul>
       <p>The full list, with Google's reason for each page, is on
       <a href="${APP_URL}/growth">Growth</a>, under Google. You get this note once per page and state.</p>`
    ),
  };
}

export function integrationErrorEmail(integrationType: string, error: string) {
  const name = integrationType === "wordpress" ? "WordPress" : integrationType;
  return {
    subject: `Publishing to your ${name} integration is failing`,
    html: layout(
      "Articles are not reaching your site",
      `<p>Publishing through your <strong>${escapeHtml(name)}</strong> integration
       failed. Generated articles are safe and will be retried automatically on
       every run, but they will not appear on your site until the integration
       works again.</p>
       <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#991b1b">
         ${escapeHtml(error)}
       </p>
       <p>Check the connection in
       <a href="${APP_URL}/settings/integrations">Settings → Connections</a>.</p>`
    ),
  };
}
