import { createClient } from "@/lib/supabase/server";
import { WordPressCard } from "@/components/integrations/wordpress-card";
import { RecentDeliveries } from "@/components/integrations/recent-deliveries";
import { selectedBusinessId } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

interface IntegrationRow {
  id: string;
  type: string;
  status: "connected" | "disconnected" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  config: Record<string, unknown>;
}

export default async function WordPressIntegrationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let wordpress: IntegrationRow | null = null;
  const businessId = user ? await selectedBusinessId(supabase, user.id) : null;
  if (businessId) {
    const { data } = await supabase
      .from("integrations")
      .select("id, type, status, last_error, last_sync_at, config")
      .eq("business_id", businessId)
      .eq("type", "wordpress")
      .maybeSingle();
    wordpress = (data ?? null) as IntegrationRow | null;
  }

  const wordpressForCard = wordpress
    ? {
        id: wordpress.id,
        status: wordpress.status,
        last_error: wordpress.last_error,
        last_sync_at: wordpress.last_sync_at,
        config: {
          site_url: (wordpress.config?.site_url as string) ?? "",
          username: (wordpress.config?.username as string) ?? "",
        },
      }
    : null;

  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">WordPress</h1>
        <p className="text-muted-foreground">
          Connect a WordPress site so scheduled articles get published automatically
          via the REST API.
        </p>
      </div>

      <WordPressCard integration={wordpressForCard} />

      <RecentDeliveries integrationType="wordpress" />
    </div>
  );
}
