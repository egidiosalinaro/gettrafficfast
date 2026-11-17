"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSettingsActive, settingsBack, settingsGroupsFor } from "./settings-nav";

interface SettingsSubmenuProps {
  businessName?: string;
  /** A platform owner (lib/owner.ts) also sees the Platform group; the server decides. */
  isOwner?: boolean;
  /** False on a deployment without billing (lib/billing-mode.ts): no Plan group. */
  billing?: boolean;
}

/**
 * Settings from `md` up: a second fixed column beside the sidebar, with the
 * same three groups as the phone's list (components/dashboard/settings-nav.ts).
 * Hidden on a phone, where `/settings` is the list itself and every page
 * has a back link instead (SettingsBackLink).
 */
export function SettingsSubmenu({
  businessName = "Business",
  isOwner = false,
  billing = true,
}: SettingsSubmenuProps) {
  const pathname = usePathname();

  return (
    <aside className="fixed left-[calc(12rem+env(safe-area-inset-left))] top-0 hidden h-screen w-56 pt-[env(safe-area-inset-top)] border-r border-r-foreground/10 bg-muted/20 md:flex flex-col">
      <div className="p-4 border-b border-b-foreground/10 flex-shrink-0">
        <Link href="/settings" className="text-sm font-semibold text-foreground hover:underline underline-offset-4">
          Settings
        </Link>
      </div>
      <nav aria-label="Settings" className="flex-1 p-4 space-y-6 overflow-y-auto">
        {settingsGroupsFor(isOwner, { billing }).map((group) => (
          <div key={group.id}>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-2 truncate">
              {group.title}
              {group.id === "site" && <span className="normal-case tracking-normal font-normal"> · {businessName}</span>}
            </h3>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = !item.external && isSettingsActive(item.href, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    {...(item.external ? { target: "_blank", rel: "noopener" } : {})}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span className="flex-1">{item.title}</span>
                    {item.external && <ExternalLink className="h-3 w-3" aria-label="opens in a new tab" />}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * The way back from a settings page. On a phone every page has it ("‹
 * Settings"), since the list is a page of its own there; from `md` up only a
 * page under another one does ("‹ Connections" on WordPress), because the
 * column already shows the list.
 */
export function SettingsBackLink() {
  const back = settingsBack(usePathname());
  if (!back) return null;

  return (
    <Link
      href={back.href}
      className={cn(
        "-ml-2 mb-2 inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground",
        !back.always && "md:hidden"
      )}
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      {back.label}
    </Link>
  );
}
