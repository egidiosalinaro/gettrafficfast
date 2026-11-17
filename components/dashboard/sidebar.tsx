"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";
import {
  BusinessSwitcher,
  type SwitcherBusiness,
} from "@/components/dashboard/business-switcher";
import {
  ACCOUNT_HREF,
  DOCS_HREF,
  appNav,
  isNavActive,
} from "@/components/dashboard/nav";

interface DashboardSidebarProps {
  userEmail?: string;
  avatarUrl?: string;
  /** Sites the shell already loaded. The switcher paints these on first render. */
  businesses?: SwitcherBusiness[];
  selectedId?: string | null;
}

/**
 * The desktop navigation: the brand, the site switcher, the four sections
 * (components/dashboard/nav.ts, the same as the phone's tab bar), and at the
 * foot the docs and the account. The account is a link to Settings →
 * Account, which holds sign out; the docs hold help and the contact address.
 */
export function DashboardSidebar({
  userEmail,
  avatarUrl,
  businesses,
  selectedId,
}: DashboardSidebarProps) {
  const pathname = usePathname();

  return (
    // Desktop only: below `md` the shell shows MobileNav's tab bar instead.
    // An iPhone in landscape (md and up) puts the notch on the left: the
    // column grows by that inset and pads it, so it still ends where the
    // content's md:ml-48 starts (the body is padded by the same inset).
    <aside className="fixed left-0 top-0 hidden h-screen w-[calc(12rem+env(safe-area-inset-left))] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] border-r border-r-foreground/10 bg-muted/30 md:flex flex-col">
      <div className="p-4 border-b border-b-foreground/10 flex-shrink-0">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          {/* The mark in the text's colour, so it holds in both themes. */}
          <BrandMark className="h-6 w-6" />
          <span className="text-base font-bold">GetTrafficFast</span>
        </Link>
      </div>
      <BusinessSwitcher businesses={businesses} selectedId={selectedId} />
      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {appNav.map((item) => {
            const Icon = item.icon;
            const active = isNavActive(item, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={itemClass(active)}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{item.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex-shrink-0 space-y-0.5 border-t border-t-foreground/10 p-2">
        <Link
          href={DOCS_HREF}
          className="flex min-h-[40px] items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <CircleHelp className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Docs and help</span>
        </Link>
        {userEmail && (
          <AccountLink
            userEmail={userEmail}
            avatarUrl={avatarUrl}
            active={isNavActive({ href: ACCOUNT_HREF }, pathname)}
          />
        )}
      </div>
    </aside>
  );
}

function itemClass(active: boolean): string {
  return cn(
    "flex min-h-[40px] items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors",
    active
      ? "bg-primary text-primary-foreground"
      : "text-foreground hover:bg-muted",
  );
}

/**
 * Who is signed in, as a way into Settings → Account. The address before the
 * @, whole on hover; the photo the sign-in provider gave, or the initials.
 */
function AccountLink({
  userEmail,
  avatarUrl,
  active,
}: {
  userEmail: string;
  avatarUrl?: string;
  active: boolean;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const showAvatar = Boolean(avatarUrl) && !avatarFailed;
  const name = userEmail.split("@")[0] || userEmail;

  return (
    <Link
      href={ACCOUNT_HREF}
      title={userEmail}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-[40px] items-center gap-2 rounded-md px-2 text-xs font-medium transition-colors",
        active ? "bg-muted text-foreground" : "text-foreground hover:bg-muted",
      )}
    >
      {showAvatar ? (
        // Plain <img>: Google avatar hosts are not in next/image remotePatterns,
        // and no-referrer avoids googleusercontent 403s.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setAvatarFailed(true)}
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
        >
          {initials(userEmail)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </Link>
  );
}

/** Two letters of the address before the @, or one when that is all there is. */
export function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  return (local || email).slice(0, 1).toUpperCase() || "U";
}
