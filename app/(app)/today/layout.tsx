import { SiteSection } from "@/components/dashboard/site-section";

export default function PlacementsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteSection>{children}</SiteSection>;
}
