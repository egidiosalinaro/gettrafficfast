"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { SCOPE_COPY } from "./scope-copy";

/**
 * Settings → Claude and API (`/settings/api-keys`): how to connect Claude
 * (claude.ai's custom connector, no key; Claude Code, with a key), then
 * create a key (shown once), copy it, revoke one. The list comes
 * from the server page; every change refreshes it (router.refresh).
 */

type Scope = "read" | "write" | "spend" | "publish";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  businessId: string | null;
  scopes: Scope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface SiteOption {
  id: string;
  name: string | null;
  website_url: string | null;
}

/**
 * A key's use over the last 7 days, from the audit log (`tool_calls`). The
 * measured cost stays in the audit log for the platform; the customer sees
 * calls only (a subscriber pays a fixed price, the owner's decision of
 * 2026-11-13), and the cost is not even in the props: they reach the browser.
 */
export interface ApiKeyUsage {
  calls: number;
}

function usageLine(usage: ApiKeyUsage | undefined): string {
  if (!usage || usage.calls === 0) return "No calls in the last 7 days";
  return `${usage.calls} call${usage.calls === 1 ? "" : "s"} in the last 7 days`;
}

function siteLabel(site: SiteOption | undefined): string {
  return site?.name || site?.website_url || "a removed site";
}

/** A timestamp as "2026-11-09 13:31 UTC": the same on the server and in the browser, so hydration agrees. */
function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={label}
      className="h-11 shrink-0 md:h-8"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function errorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: { message?: string } | string } | null)?.error;
  if (typeof error === "string") return error;
  return error?.message ?? fallback;
}

export function ApiKeysManager({
  keys,
  sites,
  mcpUrl,
  toolsUrl,
  usage,
}: {
  keys: ApiKeyRow[];
  sites: SiteOption[];
  mcpUrl: string;
  toolsUrl: string;
  /** Each key's last 7 days by key id; null when the audit log cannot be read, undefined when not loaded. */
  usage?: Record<string, ApiKeyUsage> | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState<string>("");
  const [scopes, setScopes] = useState<Scope[]>(["read", "write"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const live = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);
  const sitesById = new Map(sites.map((s) => [s.id, s]));
  const claudeCommand = `claude mcp add --transport http gettrafficfast ${mcpUrl} --header "Authorization: Bearer ${created?.key ?? "gtf_…"}"`;

  function toggleScope(scope: Scope, on: boolean) {
    setScopes((current) => (on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, businessId: siteId || null, scopes }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorMessage(payload, "The key could not be created."));
        return;
      }
      setCreated({ key: payload.key as string, name: name.trim() });
      setName("");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKeyRow) {
    if (!confirm(`Revoke "${key.name}"? Anything using it stops working on its next call.`)) return;
    setRevoking(key.id);
    setError(null);
    try {
      const res = await fetch(`/api/api-keys/${key.id}`, { method: "DELETE" });
      if (!res.ok) setError(errorMessage(await res.json().catch(() => null), "The key could not be revoked."));
      router.refresh();
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4 sm:p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold mb-1">Connect Claude</h2>
          <p className="text-sm text-muted-foreground">
            Then ask Claude for what you would do here: &ldquo;what should I reply to today?&rdquo;, &ldquo;draft a
            reply to this post&rdquo;, &ldquo;how did last week go?&rdquo;. Nothing is ever posted on X for you:
            Claude hands you the link and you post it.
          </p>
        </div>

        <section aria-labelledby="connect-claude-app" className="space-y-3">
          <h3 id="connect-claude-app" className="text-base font-semibold">
            On claude.ai, the desktop app or your phone (no key)
          </h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              In Claude, open <span className="font-medium">Customize → Connectors</span> and choose{" "}
              <span className="font-medium">Add custom connector</span>. On a Team or Enterprise plan an Owner adds
              it in Organization settings → Connectors first.
            </li>
            <li className="space-y-2">
              <span>Paste this address, and leave the OAuth client ID and secret empty:</span>
              <span className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <code className="w-full flex-1 min-w-0 break-all rounded-md border bg-muted px-3 py-2 text-sm">{mcpUrl}</code>
                <CopyButton text={mcpUrl} label="Copy the MCP endpoint" />
              </span>
            </li>
            <li>
              <span className="font-medium">Add</span>, then <span className="font-medium">Connect</span>. Sign in
              to GetTrafficFast if asked.
            </li>
            <li>
              Choose what Claude may do and for which site, then <span className="font-medium">Allow</span>. Read
              and Write are ticked; Spend and Publish only if you tick them.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">It then appears under Connected apps, where you can revoke it.</p>
        </section>

        <section aria-labelledby="connect-claude-code" className="space-y-3">
          <h3 id="connect-claude-code" className="text-base font-semibold">
            In Claude Code (with a key)
          </h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Create a key below. Tick Spend if it should draft replies or write articles. Copy it: it is shown once.</li>
            <li className="space-y-2">
              <span>Run this in a terminal, with your key in place of gtf_…:</span>
              <span className="flex flex-col items-start gap-2 sm:flex-row">
                <code className="w-full flex-1 min-w-0 break-all rounded-md border bg-muted px-3 py-2 text-xs">{claudeCommand}</code>
                <CopyButton text={claudeCommand} label="Copy the Claude Code command" />
              </span>
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Other clients: the same URL, transport &quot;Streamable HTTP&quot;, and the header{" "}
            <code>Authorization: Bearer gtf_…</code>. Add <code>x-gtf-business: &lt;site id&gt;</code> to pick a site
            with a key for every site. Without MCP, POST JSON to <code>{toolsUrl}/&lt;tool&gt;</code>; GET{" "}
            <code>{toolsUrl}</code> lists the tools.
          </p>
          <p className="text-xs text-muted-foreground">
            On an iPhone, a Shortcut in X&apos;s share sheet can add a post to your replies: POST{" "}
            <code>{`{"url": "<the link>"}`}</code> to <code>{toolsUrl}/add_x_post</code> with a key that has Write and
            Spend.
          </p>
        </section>

        <section aria-labelledby="run-from-claude" className="space-y-2">
          <h3 id="run-from-claude" className="text-base font-semibold">
            Then run your day from Claude
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <span className="font-medium">Run my day</span>: your replies one at a time, approve, fix or skip, with
              the link that opens X with the reply written. You post it yourself.
            </li>
            <li>
              <span className="font-medium">Review my week</span>: replies on X, Google and AI answers, then your next
              topics.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            On claude.ai and the Claude apps they are in the chat&apos;s + menu once GTF is connected. In Claude Code:{" "}
            <code>/mcp__gettrafficfast__daily_routine</code>.{" "}
            <Link href="/docs#routine" target="_blank" rel="noopener" className="underline underline-offset-4">
              How it works
            </Link>
          </p>
        </section>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-xl font-semibold">New key</h2>
        {created && (
          <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium">
              Your key &quot;{created.name}&quot;. Copy it now: it is not stored and is not shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 break-all rounded-md border bg-background px-3 py-2 text-sm">{created.key}</code>
              <CopyButton text={created.key} label="Copy the new key" />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
              I have copied it
            </Button>
          </div>
        )}
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              placeholder="Claude Code on my laptop"
              className="h-11 md:h-9"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-site">Site</Label>
            <select
              id="api-key-site"
              className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm md:h-9 md:text-sm"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              <option value="">Every site of this account</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  Only {siteLabel(site)}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">What it may do</legend>
            {SCOPE_COPY.map((scope) => (
              <label key={scope.id} className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={scopes.includes(scope.id)}
                  onCheckedChange={(value) => toggleScope(scope.id, value === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{scope.label}</span>
                  <span className="text-muted-foreground"> · {scope.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={creating || !name.trim() || scopes.length === 0} className="h-11 md:h-9">
            {creating ? "Creating…" : "Create key"}
          </Button>
        </form>
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-xl font-semibold">Your keys</h2>
        {live.length === 0 && <p className="text-sm text-muted-foreground">No live keys yet.</p>}
        {live.length > 0 && usage !== undefined && (
          <p className="text-xs text-muted-foreground">
            A key may make 60 calls a minute, and has daily limits on the tools that start AI work. Settings → Billing
            shows what your plan includes and what is used, across the screens and every key.
          </p>
        )}
        <ul className="divide-y">
          {live.map((key) => (
            <li key={key.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{key.name}</span>
                  <code className="text-xs text-muted-foreground">{key.prefix}…</code>
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant={scope === "spend" ? "default" : "secondary"}>
                      {scope}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {key.businessId ? `Only ${siteLabel(sitesById.get(key.businessId))}` : "Every site"} · Last used{" "}
                  {key.lastUsedAt ? when(key.lastUsedAt) : "never"} · Created {when(key.createdAt)}
                </p>
                {usage !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {usage === null ? "Usage is not available right now" : usageLine(usage[key.id])}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => handleRevoke(key)} disabled={revoking === key.id} className="h-11 md:h-8">
                {revoking === key.id ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
        {revoked.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Revoked keys ({revoked.length})</summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {revoked.map((key) => (
                <li key={key.id}>
                  {key.name} <code className="text-xs">{key.prefix}…</code> · revoked {when(key.revokedAt)} · last used{" "}
                  {key.lastUsedAt ? when(key.lastUsedAt) : "never"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </div>
  );
}
