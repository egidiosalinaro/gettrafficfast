import type { Metadata } from "next";
import { LandingHeader } from "@/components/landing/header";
import { LandingFooter } from "@/components/landing/footer";
import { enabledAnswerEngines } from "@/components/landing/enabled-engines";
import { DocsContent, DocsToc } from "@/components/docs/docs-content";
import { docToolGroups } from "@/components/docs/tool-groups";
import { TOOLS } from "@/lib/tools/registry";
import { docsLimits } from "@/components/docs/docs-limits";
import { SITE_URL } from "@/lib/site";

/**
 * The public documentation, open to anyone and to crawlers
 * (lib/public-paths.ts, app/sitemap.ts). It replaced the in-app Help and
 * Contact pages on 2026-11-14; their old paths redirect here
 * (lib/legacy-redirects.ts).
 *
 * Read per request, like the landing: the engines named are the ones the
 * server has switched on, and the header asks who is signed in.
 */

export const dynamic = "force-dynamic";

const DESCRIPTION =
  "How GetTrafficFast works, what its numbers mean and how they are measured, and how to run it from Claude through MCP.";

export const metadata: Metadata = {
  title: "Docs - GetTrafficFast",
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/docs` },
  openGraph: {
    title: "Docs - GetTrafficFast",
    description: DESCRIPTION,
    siteName: "GetTrafficFast",
    type: "website",
    url: "/docs",
  },
};

export default function DocsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <LandingHeader />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-12 md:py-16">
          <div className="mb-10 max-w-[760px]">
            <h1 className="text-4xl font-bold mb-3">Docs</h1>
            <p className="text-lg text-muted-foreground">
              How GetTrafficFast works, what its numbers mean, and how to run it from Claude. Short on purpose: each
              section is a minute to read.
            </p>
          </div>
          <div className="grid gap-10 lg:grid-cols-[200px_minmax(0,760px)] lg:gap-14">
            <aside className="min-w-0">
              <DocsToc />
            </aside>
            <DocsContent engines={enabledAnswerEngines()} toolGroups={docToolGroups(TOOLS.list())} limits={docsLimits()} />
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
