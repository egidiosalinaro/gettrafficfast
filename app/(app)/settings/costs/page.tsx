import { notFound } from "next/navigation";
import { requireAppAccess } from "@/lib/app-access";
import { isPlatformOwner } from "@/lib/owner";
import { createAdminClient } from "@/lib/supabase/admin";
import { readPlatformCosts } from "@/lib/limits/platform-costs";
import { PlatformCostsView } from "@/components/owner/platform-costs-view";
import { ReviewerAccountPanel } from "@/components/owner/reviewer-account-panel";
import { passwordLoginEmails } from "@/lib/password-login";

export const dynamic = "force-dynamic";

/**
 * The owner's costs (docs/API.md "The owner's costs"). Anyone who is not a
 * platform owner (lib/owner.ts) gets the app's 404, the page a path that does
 * not exist gets, before anything is read: no hint that it is here. The
 * reading is the service role's, after that check.
 */
export default async function PlatformCostsPage() {
  const { userId } = await requireAppAccess();
  if (!isPlatformOwner(userId)) notFound();
  const costs = await readPlatformCosts(createAdminClient());
  return (
    <div className="flex w-full flex-col gap-6">
      <PlatformCostsView costs={costs} />
      <ReviewerAccountPanel emails={passwordLoginEmails()} />
    </div>
  );
}
