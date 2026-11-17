"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { InlineConfirm, OUTLINE_ANSWER } from "@/components/ui/inline-confirm";

/** Asked inline on the first tap of Disconnect; the second tap disconnects. */
export const WEBHOOK_DISCONNECT_QUESTION =
  "Disconnect the webhook? Scheduled articles will stop publishing.";

interface ConnectedIntegration {
  id: string;
  status: "connected" | "disconnected" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  config: { url?: string };
}

interface Props {
  integration: ConnectedIntegration | null;
  /** Set when this business is gettrafficfa.st itself; secret comes from env. */
  ownReceiverUrl?: string | null;
}

export function WebhookCard({ integration, ownReceiverUrl }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState(ownReceiverUrl ?? "");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/webhook/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          ownReceiverUrl ? { url } : { url, secret }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Connection failed");
        return;
      }
      setUrl("");
      setSecret("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      await fetch("/api/integrations/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "webhook" }),
      });
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (integration) {
    return (
      <Card className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-semibold">Webhook</h2>
              <Badge variant={integration.status === "connected" ? "default" : "destructive"}>
                {integration.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground break-all">
              {integration.config.url}
            </p>
          </div>
          <InlineConfirm
            question={WEBHOOK_DISCONNECT_QUESTION}
            confirmLabel="Disconnect"
            onConfirm={handleDisconnect}
            buttonClassName={OUTLINE_ANSWER}
            className="max-w-[16rem] shrink-0 text-right [&>div]:justify-end"
            trigger={(ask) => (
              <Button variant="outline" onClick={ask} disabled={submitting}>
                Disconnect
              </Button>
            )}
          />
        </div>
        {integration.last_error && (
          <p className="text-sm text-destructive">Last error: {integration.last_error}</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold mb-1">Webhook</h2>
        <p className="text-sm text-muted-foreground">
          Send each generated article to your own endpoint as JSON. Requests are
          signed with HMAC-SHA256 over a timestamp and the body
          (<code>X-GTF-Timestamp</code>, <code>X-GTF-Signature</code>) so your
          server can verify they come from GetTrafficFast and refuse a replayed
          one. The older <code>X-Signature</code> header is still sent. Your endpoint must
          respond <code>200</code> with <code>{'{"url": "https://..."}'}</code>:
          the public URL of the published post.
        </p>
      </div>
      <form onSubmit={handleConnect} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="webhook-url">Endpoint URL</Label>
          <Input
            id="webhook-url"
            type="url"
            placeholder="https://your-site.com/api/publish-article"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            readOnly={Boolean(ownReceiverUrl)}
          />
        </div>
        {ownReceiverUrl ? (
          <p className="text-sm text-muted-foreground">
            This is this site&apos;s own receiver. Deliveries are signed with{" "}
            <code>BLOG_WEBHOOK_SECRET</code>, already set on Vercel. You do not
            paste a second copy here.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="webhook-secret">Shared secret</Label>
            <Input
              id="webhook-secret"
              type="password"
              placeholder="A long random string you also store on your server"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
            />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Testing connection..." : "Connect Webhook"}
        </Button>
      </form>
    </Card>
  );
}
