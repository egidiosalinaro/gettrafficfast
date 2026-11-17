import { createClient } from "@/lib/supabase/server";
import { WebhookCard } from "@/components/integrations/webhook-card";
import { RecentDeliveries } from "@/components/integrations/recent-deliveries";
import { AiAgentPrompt } from "@/components/integrations/ai-agent-prompt";
import { Card } from "@/components/ui/card";
import { selectedBusiness } from "@/lib/tenancy";
import { isOwnSite, ownWebhookUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

interface IntegrationRow {
  id: string;
  type: string;
  status: "connected" | "disconnected" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  config: Record<string, unknown>;
}

export default async function WebhookIntegrationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let webhook: IntegrationRow | null = null;
  const business = user ? await selectedBusiness(supabase, user.id) : null;
  const businessId = business?.id ?? null;
  if (businessId) {
    const { data } = await supabase
      .from("integrations")
      .select("id, type, status, last_error, last_sync_at, config")
      .eq("business_id", businessId)
      .eq("type", "webhook")
      .maybeSingle();
    webhook = (data ?? null) as IntegrationRow | null;
  }

  const webhookForCard = webhook
    ? {
        id: webhook.id,
        status: webhook.status,
        last_error: webhook.last_error,
        last_sync_at: webhook.last_sync_at,
        config: {
          url: (webhook.config?.url as string) ?? "",
        },
      }
    : null;

  const ownSite = isOwnSite(business?.website_url);

  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Webhook</h1>
        <p className="text-muted-foreground">
          Publish scheduled articles to any custom site by receiving them on your
          own HTTPS endpoint.
        </p>
      </div>

      <WebhookCard
        integration={webhookForCard}
        ownReceiverUrl={ownSite ? ownWebhookUrl() : null}
      />

      {webhook?.status !== "connected" && !ownSite && <AiAgentPrompt />}

      <RecentDeliveries integrationType="webhook" />

      {webhook?.status !== "connected" && (
      <Card className="p-6 bg-muted/40 space-y-3">
        <h3 className="font-semibold">Payload reference</h3>
        <p className="text-sm text-muted-foreground">
          On every publish, GetTrafficFast sends a <code>POST</code> request with
          this JSON body:
        </p>
        <pre className="text-xs bg-background border border-border rounded-md p-3 overflow-x-auto">
{`{
  "event": "article.publish",
  "title": "Article title",
  "slug": "article-slug",
  "html": "<h1>...</h1>...",
  "keyword": "target keyword",
  "scheduled_date": "2026-07-20",

  "schema_version": 2,
  "article_id": "8f14e45f-...",
  "body_html": "<p>...</p><h2 id=\\"first-section\\">...</h2>...",
  "excerpt": "First paragraph, plain text…",
  "seo": {
    "meta_title": "Article title",
    "meta_description": "First ~155 chars, plain text…"
  },
  "headings": [{ "level": 2, "id": "first-section", "text": "..." }],

  "delivery_id": "0b6f3c1e-..."
}`}
        </pre>
        <p className="text-sm text-muted-foreground">
          Prefer the structured fields: render <code>title</code> yourself and
          use <code>body_html</code> (it has no duplicate <code>&lt;h1&gt;</code>{" "}
          and its <code>h2/h3</code> carry <code>id</code> anchors). When a hero
          image exists it is the first <code>&lt;figure class=&quot;gtf-hero&quot;&gt;</code>{" "}
          in that HTML. Upsert by{" "}
          <code>article_id</code> so republishes update the same post. The
          legacy fields (<code>html</code> with the <code>&lt;h1&gt;</code>{" "}
          included) never change, so existing receivers keep working.
        </p>
        <p className="text-sm text-muted-foreground">
          Each request carries <code>X-GTF-Timestamp</code> (Unix seconds) and{" "}
          <code>X-GTF-Signature: v2=&lt;hex&gt;</code>, the HMAC-SHA256 of{" "}
          <code>timestamp + &quot;.&quot; + raw body</code> keyed with your shared
          secret. Verify it before trusting the payload, refuse a timestamp more
          than 5 minutes from your clock, and ignore a <code>delivery_id</code>{" "}
          you have already seen: that is what stops a captured request from being
          replayed. The older <code>X-Signature</code> header (HMAC of the body
          alone, no timestamp) is still sent for receivers written for it; move
          to the new one. Test requests use{" "}
          <code>{'{"event": "test"}'}</code> and only need a 2xx response.
        </p>
      </Card>
      )}
    </div>
  );
}
