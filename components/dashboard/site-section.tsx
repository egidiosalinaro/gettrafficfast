import { requireSite } from "@/lib/app-access";
import { SectionFrame } from "@/components/dashboard/section-frame";

/**
 * The content column of a section that needs a site.
 *
 * The sidebar is the shell's, not this frame's: rendering it here again would
 * remount the site switcher on every menu click. The frame itself (sidebar
 * offset, room for the phone's tab bar) is SectionFrame, shared with the
 * loading skeleton.
 */
export async function SiteSection({ children }: { children: React.ReactNode }) {
  await requireSite();

  return <SectionFrame>{children}</SectionFrame>;
}
