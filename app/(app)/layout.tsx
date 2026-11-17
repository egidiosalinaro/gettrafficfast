import { avatarUrlFrom, requireAppAccess } from "@/lib/app-access";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { MobileNav, MobileSiteBar } from "@/components/dashboard/mobile-nav";
import { AppScroll } from "@/components/dashboard/app-scroll";
import { OnboardingHost } from "@/components/onboarding/getting-started";

/**
 * One shell for every signed-in section: Today, Growth, Content, Settings
 * (components/dashboard/nav.ts).
 *
 * The sidebar used to be rendered by each section's own layout. Those layouts
 * are siblings, so a click from one section to another unmounted the whole
 * sidebar and mounted a new one. The site switcher starts empty and only
 * fills in after `/api/business/list` returns, which is the
 * disappear-and-reappear. This layout stays mounted across those
 * navigations, and it already knows the account's sites, so the control is in
 * the first paint.
 *
 * Below `md` the sidebar is hidden: the site switcher is the first row of the
 * scrolling area (MobileSiteBar) and MobileNav's bottom tab bar holds the four
 * sections. The two share one nav definition.
 *
 * The body is padded by the safe-area insets (app/globals.css), so the shell
 * is one screen tall minus the top inset: `min-h-screen` alone made every
 * page scroll by the height of an iPhone's status bar.
 */
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, businesses, selected } = await requireAppAccess();
  const selectedId = selected?.id ?? null;

  return (
    // Phone: exactly one screen tall, a scrolling area over the tab bar in
    // flow (components/dashboard/app-scroll.tsx explains why nothing is
    // fixed). md and up: as before, the page scrolls beside the sidebar.
    <div className="flex h-[calc(100dvh-env(safe-area-inset-top))] flex-col overflow-hidden md:h-auto md:min-h-[calc(100vh-env(safe-area-inset-top))] md:flex-row md:overflow-visible">
      <DashboardSidebar
        userEmail={user?.email}
        avatarUrl={avatarUrlFrom(user)}
        businesses={businesses}
        selectedId={selectedId}
      />
      <AppScroll>
        {/* No site yet: nothing to switch, Settings → Business makes one. */}
        {businesses.length > 0 && (
          <MobileSiteBar businesses={businesses} selectedId={selectedId} />
        )}
        {children}
      </AppScroll>
      <MobileNav />
      <OnboardingHost />
    </div>
  );
}
