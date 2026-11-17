"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  BusinessSwitcher,
  type SwitcherBusiness,
} from "@/components/dashboard/business-switcher";
import { appNav, isNavActive, type NavItem } from "@/components/dashboard/nav";

/**
 * The phone's navigation, below `md`: a bottom tab bar with the four
 * sections, the same as the desktop sidebar (components/dashboard/nav.ts).
 * There is no "More": the account and the docs are rows of Settings. At `md`
 * and up it renders nothing visible and the sidebar takes over.
 *
 * The bar is not fixed: it is the last row of the app shell, under the
 * scrolling area (components/dashboard/app-scroll.tsx), so iOS cannot leave
 * it in the middle of the screen. Content keeps room only for the Getting
 * started pill above it (`pb-mobile-chrome`, app/globals.css).
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="relative z-40 shrink-0 border-t border-t-foreground/10 bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden"
    >
      <ul className="grid grid-cols-4">
        {appNav.map((tab) => (
          <li key={tab.href}>
            <TabLink item={tab} active={isNavActive(tab, pathname)} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The phone's top row: which site this is, and the menu to switch. The first
 * row of the scrolling area, above the page, so it scrolls away with it and
 * costs no height while reading. The desktop has the same control in the
 * sidebar. The shell renders it only when the account has a site.
 */
export function MobileSiteBar({
  businesses,
  selectedId,
}: {
  businesses: SwitcherBusiness[];
  selectedId: string | null;
}) {
  return (
    <div className="flex shrink-0 items-center px-4 pt-2 md:hidden">
      <BusinessSwitcher businesses={businesses} selectedId={selectedId} variant="bar" />
    </div>
  );
}

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={tabClass(active)}
    >
      <Icon className="h-[22px] w-[22px]" aria-hidden="true" />
      <span>{item.title}</span>
    </Link>
  );
}

/** 56px tall: over the 44px minimum comfortable touch target. */
function tabClass(active: boolean): string {
  return cn(
    "flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] transition-colors",
    active
      ? "font-semibold text-foreground"
      : "font-medium text-muted-foreground hover:text-foreground",
  );
}
