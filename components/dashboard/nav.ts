import {
  FileText,
  Inbox,
  SlidersVertical,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

/**
 * The signed-in map: four sections, one definition for the desktop sidebar
 * and the phone's tab bar, with the same name as each page's heading.
 *
 * - Today: what asks for a gesture now, the replies to post first. It is
 *   where a sign-in lands. It replaced Overview and Replies.
 * - Growth: X, Google and AI answers, this week against the last. It
 *   replaced Results and Prompts.
 * - Content: articles and the topics they come from. It replaced Articles
 *   and Keywords.
 * - Settings: the site, the account (with sign out), and the docs.
 *
 * Help and Contact Us are the public docs at `/docs`, linked under the
 * sidebar and from Settings. There is no "More": the four fit a phone. The
 * old paths redirect to their new homes (lib/legacy-redirects.ts,
 * lib/content-paths.ts, APP_HOME), so no item is kept for them.
 */
export const appNav = [
  { title: "Today", href: "/today", icon: Inbox },
  { title: "Growth", href: "/growth", icon: TrendingUp },
  { title: "Content", href: "/content", icon: FileText },
  { title: "Settings", href: "/settings", icon: SlidersVertical },
] as const satisfies ReadonlyArray<NavItem>;

/** The public docs, which hold help and the contact address. */
export const DOCS_HREF = "/docs";

/** Where the account lives: profile, appearance, sign out. */
export const ACCOUNT_HREF = "/settings/account";

/**
 * Whether `item` is the current section: its own path or a page under it
 * (`/growth/ai` is Growth), never a longer sibling name (`/growthx`).
 */
export function isNavActive(
  item: Pick<NavItem, "href">,
  pathname: string | null,
): boolean {
  if (!pathname) return false;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
