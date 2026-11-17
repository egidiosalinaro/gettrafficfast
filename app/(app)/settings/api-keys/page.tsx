import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listApiKeys, type ApiKeyRecord } from "@/lib/api-keys";
import { listBusinesses, type BusinessSummary } from "@/lib/tenancy";
import { SITE_URL } from "@/lib/site";
import { loadKeyUsage, type KeyUsage } from "@/lib/tools/usage";
import { listConnectedApps, type ConnectedApp } from "@/lib/oauth/tokens";
import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { ConnectedApps } from "@/components/settings/connected-apps";

export const dynamic = "force-dynamic";

/**
 * Settings → Claude and API (`/settings/api-keys`, docs/API.md): how to
 * connect Claude, then the API keys. The keys, the sites and each key's last
 * 7 days (calls, from the audit log `tool_calls`; the measured cost stays
 * there for the platform and is never shown to the customer) are read
 * here, through the person's own client; creating and revoking go through
 * /api/api-keys, which takes the session cookie only. Below them, the apps
 * connected over OAuth (claude.ai and the Claude apps): their grants are read
 * through the person's own client, the apps' names through the service role
 * for those grants only; Revoke goes through /api/connected-apps/:id.
 */
export default async function ApiKeysPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let keys: ApiKeyRecord[] = [];
  let sites: BusinessSummary[] = [];
  let usage: Record<string, KeyUsage> | null = null;
  let loadError: string | null = null;
  let apps: ConnectedApp[] = [];
  let appsError: string | null = null;
  if (user) {
    try {
      const [listedKeys, listedSites, keyUsage] = await Promise.all([
        listApiKeys(supabase, user.id),
        listBusinesses(supabase, user.id),
        // Null when the audit log cannot be read: the page says so rather than show zeros.
        loadKeyUsage(supabase, 7),
      ]);
      keys = listedKeys;
      sites = listedSites;
      usage = keyUsage ? Object.fromEntries(keyUsage) : null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    // Apart from the keys: a connected-apps table that cannot be read must not hide the keys.
    try {
      apps = await listConnectedApps(supabase, createAdminClient(), user.id);
    } catch (err) {
      appsError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Claude and API</h1>
        <p className="text-muted-foreground">
          Run GetTrafficFast by talking to Claude. Everything you do on these screens is also a tool Claude can call
          through MCP, with the same checks: your sites only, your plan, the daily limits. Scripts use the same tools
          over the API with a key.{" "}
          <Link href="/docs#claude" target="_blank" rel="noopener" className="text-foreground underline underline-offset-4">
            What the tools can do
          </Link>
          .
        </p>
      </div>
      {loadError && <p className="text-sm text-destructive">Your keys could not be loaded: {loadError}</p>}
      <ApiKeysManager
        keys={keys}
        sites={sites}
        usage={usage}
        mcpUrl={`${SITE_URL}/api/mcp`}
        toolsUrl={`${SITE_URL}/api/v1/tools`}
      />
      <ConnectedApps apps={apps} sites={sites} loadError={appsError} />
    </div>
  );
}
