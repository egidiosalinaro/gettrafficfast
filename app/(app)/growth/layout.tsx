import { SiteSection } from "@/components/dashboard/site-section";

export default function GrowthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteSection>{children}</SiteSection>;
}
