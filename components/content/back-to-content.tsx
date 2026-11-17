import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { CONTENT_PATHS } from "@/lib/content-paths";

/** The way back from a view behind Content, 44px tall on a phone. */
export function BackToContent() {
  return (
    <Link
      href={CONTENT_PATHS.home}
      className="-ml-1 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:min-h-8"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      Content
    </Link>
  );
}
