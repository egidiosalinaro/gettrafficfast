import { CheckCircle2, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { selectedBusinessId } from "@/lib/tenancy";
import { listDeliveries } from "@/lib/integrations/deliveries";
import { UI_LOCALE } from "@/lib/format";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(UI_LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function RecentDeliveries({
  integrationType,
}: {
  integrationType: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return null;

  // The same read as `list_deliveries` (lib/integrations/deliveries.ts).
  const attempts = await listDeliveries(supabase, {
    userId: user.id,
    businessId,
    integrationType,
    limit: 10,
  });
  if (attempts.length === 0) return null;

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h3 className="font-semibold">Recent deliveries</h3>
        <p className="text-sm text-muted-foreground">
          The last publish attempts for this site.
        </p>
      </div>
      <ul className="space-y-2">
        {attempts.map((attempt) => (
          <li
            key={attempt.id}
            className="flex items-start gap-2 text-sm border-b border-border last:border-b-0 pb-2 last:pb-0"
          >
            {attempt.ok ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              {attempt.ok && attempt.publishedUrl ? (
                <a
                  href={attempt.publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline break-all"
                >
                  {attempt.publishedUrl}
                </a>
              ) : (
                <span className="text-destructive break-words">
                  {attempt.error ?? "Unknown error"}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDate(attempt.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
