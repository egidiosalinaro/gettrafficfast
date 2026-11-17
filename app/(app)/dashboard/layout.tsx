import { SiteSection } from "@/components/dashboard/site-section";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteSection>{children}</SiteSection>;
}
