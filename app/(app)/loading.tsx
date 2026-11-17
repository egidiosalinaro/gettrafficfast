import { SectionSkeleton } from "@/components/dashboard/section-skeleton";

/**
 * Shown the moment a menu item is tapped, while the next section's layout
 * checks the site and subscription. The shell (sidebar, tab bar) stays.
 */
export default function Loading() {
  return <SectionSkeleton framed />;
}
