import {
  BookOpen,
  Bot,
  Briefcase,
  CreditCard,
  MessageSquareText,
  Plug,
  Receipt,
  Rocket,
  User,
  type LucideIcon,
} from "lucide-react";

/**
 * Settings, grouped the way a person thinks about them (phase 2 of the UX
 * simplification, approved by the owner on 2026-11-13): what is about this
 * site, what is about the plan, what is about you. One list, read by the
 * phone's Settings page (`app/(app)/settings/page.tsx`), the desktop column
 * (`SettingsSubmenu`) and the back link of every settings page, so the three
 * cannot name a page differently.
 *
 * Paths kept their old names on purpose: the Search Console callback, the
 * Stripe portal and the onboarding emails return to them. Only the labels
 * and the grouping changed. Images & video (`/settings/generation`) is part
 * of Autopilot now; its old path redirects (`lib/legacy-redirects.ts`).
 *
 * A plain module, not a client one: a server page that imported this list
 * from a "use client" file would get a reference, not the array.
 */

export interface SettingsItem {
  title: string;
  href: string;
  /** One line under the title on the phone's list. */
  description: string;
  icon: LucideIcon;
  /** Opens outside the app (the public docs), in a new tab. */
  external?: boolean;
}

export interface SettingsGroup {
  id: "site" | "plan" | "you" | "owner";
  title: string;
  items: readonly SettingsItem[];
}

export const settingsGroups: readonly SettingsGroup[] = [
  {
    id: "site",
    title: "This site",
    items: [
      {
        title: "Business",
        href: "/settings/business",
        description: "Name, site, niche, language",
        icon: Briefcase,
      },
      {
        title: "Voice and facts",
        href: "/settings/voice",
        description: "About you, facts for articles, your notes",
        icon: MessageSquareText,
      },
      {
        title: "Connections",
        href: "/settings/integrations",
        description: "Search Console, X, your blog",
        icon: Plug,
      },
      {
        title: "Claude and API",
        href: "/settings/api-keys",
        description: "Do everything by talking to Claude, through MCP",
        icon: Bot,
      },
      {
        title: "Autopilot",
        href: "/settings/automation",
        description: "Topics, schedule, images",
        icon: Rocket,
      },
    ],
  },
  {
    id: "plan",
    title: "Plan",
    items: [
      {
        title: "Billing",
        href: "/settings/billing",
        description: "What your plan includes, what you have used, invoices",
        icon: CreditCard,
      },
    ],
  },
  {
    id: "you",
    title: "You",
    items: [
      {
        title: "Account",
        href: "/settings/account",
        description: "Email, appearance, sign out",
        icon: User,
      },
      {
        title: "Docs and help",
        href: "/docs",
        description: "How GetTrafficFast works, and how to reach us",
        icon: BookOpen,
        external: true,
      },
    ],
  },
];

/** Every settings entry, in the order the groups list them. */
export const settingsItems: readonly SettingsItem[] = settingsGroups.flatMap((group) => group.items);

/**
 * The platform owner's group (lib/owner.ts), listed last and only for an
 * owner: the server decides, and passes `isOwner` to the list and the
 * column. Anyone else never sees the row, and the page answers them 404.
 */
export const ownerSettingsGroup: SettingsGroup = {
  id: "owner",
  title: "Platform",
  items: [
    {
      title: "Costs",
      href: "/settings/costs",
      description: "What the platform pays, and each account's AI ceiling",
      icon: Receipt,
    },
  ],
};

/**
 * The groups this person sees: everyone's, and the owner's group for an
 * owner. `billing: false` drops the Plan group, on a deployment that runs
 * without billing (BILLING_DISABLED=1, lib/billing-mode.ts); the server
 * decides and passes it, as it does `isOwner`.
 */
export function settingsGroupsFor(
  isOwner: boolean,
  { billing = true }: { billing?: boolean } = {}
): readonly SettingsGroup[] {
  const groups = billing ? settingsGroups : settingsGroups.filter((group) => group.id !== "plan");
  return isOwner ? [...groups, ownerSettingsGroup] : groups;
}

/** True when `pathname` is `href` or a page under it. */
export function isSettingsActive(href: string, pathname: string | null): boolean {
  return pathname === href || Boolean(pathname?.startsWith(`${href}/`));
}

export interface SettingsBack {
  href: string;
  label: string;
  /** Shown from `md` up too: a page under a settings page has no column entry of its own. */
  always: boolean;
}

/**
 * Where a settings page's back link goes. A page of the list goes back to
 * Settings, on a phone only (from `md` up the column is there). A page under
 * one (WordPress, under Connections) goes back to that entry, on every
 * screen. Settings itself has none.
 */
export function settingsBack(pathname: string | null): SettingsBack | null {
  if (!pathname || pathname === "/settings" || !pathname.startsWith("/settings/")) return null;
  const parent = settingsItems.find((item) => !item.external && pathname.startsWith(`${item.href}/`));
  if (parent) return { href: parent.href, label: parent.title, always: true };
  return { href: "/settings", label: "Settings", always: false };
}
