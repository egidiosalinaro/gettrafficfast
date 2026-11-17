import { requireAppAccess } from "@/lib/app-access";
import { isPlatformOwner } from "@/lib/owner";
import { billingDisabled } from "@/lib/billing-mode";
import {
  SettingsBackLink,
  SettingsSubmenu,
} from "@/components/dashboard/settings-submenu";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Settings is where a site is created. Do not send a siteless account
  // away from here: this is the page that fixes it, and a redirect back to
  // itself would loop.
  const { userId, user, selected } = await requireAppAccess();
  const businessName =
    selected?.name ||
    selected?.website_url ||
    user?.email?.split("@")[0] ||
    "Business";

  return (
    <>
      {/* Desktop: a second fixed column beside the sidebar (192px + 224px). */}
      <SettingsSubmenu businessName={businessName} isOwner={isPlatformOwner(userId)} billing={!billingDisabled()} />
      <div className="flex-1 min-w-0 flex flex-col md:ml-[416px] pb-mobile-chrome">
        <div className="flex-1 p-4 md:p-6 overflow-auto">
          {/* Phone: /settings is the grouped list, and each page leads back to it. */}
          <SettingsBackLink />
          {children}
        </div>
      </div>
    </>
  );
}
