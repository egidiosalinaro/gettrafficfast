import { SiteSection } from "@/components/dashboard/site-section";

/** Content needs a site: an account without one is sent to Settings → Business. */
export default function ContentLayout({ children }: { children: React.ReactNode }) {
  return <SiteSection>{children}</SiteSection>;
}
