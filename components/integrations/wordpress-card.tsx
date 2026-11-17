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
export const WORDPRESS_DISCONNECT_QUESTION =
  "Disconnect WordPress? Scheduled articles will stop publishing.";

interface ConnectedIntegration {
  id: string;
  status: "connected" | "disconnected" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  config: { site_url?: string; username?: string };
}

interface Props {
  integration: ConnectedIntegration | null;
}

export function WordPressCard({ integration }: Props) {
  const router = useRouter();
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/wordpress/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl, username, applicationPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Connection failed");
        return;
      }
      setSiteUrl("");
      setUsername("");
      setApplicationPassword("");
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
        body: JSON.stringify({ type: "wordpress" }),
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
              <h2 className="text-xl font-semibold">WordPress</h2>
              <Badge variant={integration.status === "connected" ? "default" : "destructive"}>
                {integration.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{integration.config.site_url}</p>
            <p className="text-xs text-muted-foreground">
              User: {integration.config.username}
            </p>
          </div>
          <InlineConfirm
            question={WORDPRESS_DISCONNECT_QUESTION}
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
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold mb-1">WordPress</h2>
        <p className="text-sm text-muted-foreground">
          Publish generated articles to your WordPress site via the REST API. Create an{" "}
          <a
            href="https://wordpress.org/documentation/article/application-passwords/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Application Password
          </a>{" "}
          for the connecting user.
        </p>
      </div>
      <form onSubmit={handleConnect} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="wp-site-url">Site URL</Label>
          <Input
            id="wp-site-url"
            type="url"
            placeholder="https://your-site.com"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wp-username">Username</Label>
          <Input
            id="wp-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wp-app-password">Application Password</Label>
          <Input
            id="wp-app-password"
            type="password"
            placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            value={applicationPassword}
            onChange={(e) => setApplicationPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Connecting..." : "Connect WordPress"}
        </Button>
      </form>
    </Card>
  );
}
