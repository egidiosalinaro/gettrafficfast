import Link from "next/link";
import { ChevronRight, Globe, LineChart, Webhook } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { selectedBusinessId } from "@/lib/tenancy";
import {
  SEARCH_CONSOLE_CATALOG_ID,
  connectedCatalogIds,
} from "@/lib/integrations/catalog";
import { loadVoiceSettings } from "@/lib/voice/read";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { XAccountCard } from "@/components/settings/x-account";
import { inferredXHandle } from "@/lib/placements/x-handle";

export const dynamic = "force-dynamic";

interface ConnectionRow {
  id: "wordpress" | "webhook" | typeof SEARCH_CONSOLE_CATALOG_ID;
  name: string;
  description: string;
  icon: typeof Globe;
  href: string;
}

const SEARCH_CONSOLE: ConnectionRow = {
  id: SEARCH_CONSOLE_CATALOG_ID,
  name: "Google Search Console",
  description: "Clicks, impressions and positions of your pages, counted by Google. Read-only.",
  icon: LineChart,
  href: "/settings/integrations/search-console",
};

const DESTINATIONS: ConnectionRow[] = [
  {
    id: "wordpress",
    name: "WordPress",
    description: "Articles are published to your WordPress site on their day.",
    icon: Globe,
    href: "/settings/integrations/wordpress",
  },
  {
    id: "webhook",
    name: "Webhooks",
    description: "Any other site: each article is sent, signed, to an address you choose.",
    icon: Webhook,
    href: "/settings/integrations/webhook",
  },
];

/** Listed so nobody looks for them, never offered: no adapter publishes there yet. */
const COMING_SOON = ["Shopify", "Wix", "Webflow", "Framer"];

function ConnectionLink({ row, connected, first }: { row: ConnectionRow; connected: boolean; first: boolean }) {
  const Icon = row.icon;
  return (
    <Link
      href={row.href}
      className={
        "flex min-h-[60px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60" +
        (first ? "" : " border-t border-border")
      }
    >
      <Icon className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[15px] font-medium">
          {row.name}
          {connected && <Badge>Connected</Badge>}
        </span>
        <span className="text-xs leading-snug text-muted-foreground">{row.description}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

function SectionHeading({ id, title, children }: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

/**
 * Settings → Connections (`/settings/integrations`, the path kept because
 * Google's consent screen and the onboarding emails return to it): what this
 * site reads from (Search Console, X) and where it publishes (the blog).
 *
 * The Connected badge is the union of `integrations` and
 * `analytics_connections` (lib/integrations/catalog.ts). X runs for every
 * site when the platform has it; the site's X account is
 * `voice_settings.xHandle`, read here and saved in place.
 */
export default async function ConnectionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const businessId = user ? await selectedBusinessId(supabase, user.id) : null;
  let connectedTypes = new Set<string>();
  let xHandle: string | null = null;
  let inferredHandle: string | null = null;
  let hasBusiness = false;

  if (user && businessId) {
    // Destinations in `integrations`, Search Console in `analytics_connections`.
    // The credential columns are not selected: this page only needs status.
    const [{ data: publishing }, { data: analytics }, voice, inferred] = await Promise.all([
      supabase.from("integrations").select("type, status").eq("business_id", businessId),
      supabase.from("analytics_connections").select("provider, status").eq("business_id", businessId),
      loadVoiceSettings(supabase, user.id, businessId),
      inferredXHandle(supabase, businessId),
    ]);
    connectedTypes = connectedCatalogIds({
      publishing: (publishing ?? []).map((row) => ({ type: row.type as string, status: row.status as string })),
      analytics: (analytics ?? []).map((row) => ({ provider: row.provider as string, status: row.status as string })),
    });
    xHandle = voice.settings.xHandle;
    inferredHandle = inferred;
    hasBusiness = voice.hasBusiness;
  }

  // A destination type the catalog no longer offers, still connected on an old row, stays visible.
  const legacyConnected = ["shopify", "webflow"].filter((type) => connectedTypes.has(type));

  return (
    <div className="flex-1 w-full flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Connections</h1>
        <p className="text-muted-foreground">
          Where GetTrafficFast reads your numbers, and where it publishes your articles.
        </p>
      </div>

      <section aria-labelledby="connections-google" className="space-y-3">
        <SectionHeading id="connections-google" title="Google" />
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <ConnectionLink row={SEARCH_CONSOLE} connected={connectedTypes.has(SEARCH_CONSOLE.id)} first />
        </div>
      </section>

      <section aria-labelledby="connections-x" className="space-y-3">
        <SectionHeading id="connections-x" title="X">
          Every day, GetTrafficFast looks on X for fresh posts about your topics. They arrive in your replies with a
          draft. The numbers of the replies you post there (views, likes, replies) are read once a day too, and the
          link of a reply you mark as posted is found on X for you, once GTF knows your X account. Nothing is ever
          posted for you.
        </SectionHeading>
        <XAccountCard saved={xHandle} inferred={inferredHandle} available={isXApiEnabled()} hasBusiness={hasBusiness} />
      </section>

      <section aria-labelledby="connections-blog" className="space-y-3">
        <SectionHeading id="connections-blog" title="Your blog">
          Where finished articles are published. Connect one; without it, copy an article&apos;s HTML or Markdown
          from its page and paste it into any site.
        </SectionHeading>
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          {DESTINATIONS.map((row, index) => (
            <ConnectionLink key={row.id} row={row} connected={connectedTypes.has(row.id)} first={index === 0} />
          ))}
        </div>
        {legacyConnected.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Also connected, from an older setup: {legacyConnected.join(", ")}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">{COMING_SOON.join(", ")}: coming soon, not connected yet.</p>
      </section>
    </div>
  );
}
