import type { Metadata } from "next";
import Link from "next/link";
import { LandingHeader } from "@/components/landing/header";
import { LandingFooter } from "@/components/landing/footer";
import { DocsToc } from "@/components/docs/docs-content";
import { McpDocsContent } from "@/components/docs/mcp-content";
import { MCP_DOC_SECTIONS } from "@/components/docs/mcp-sections";
import { toolAreas } from "@/components/docs/tool-areas";
import { docsLimits } from "@/components/docs/docs-limits";
import { TOOLS } from "@/lib/tools/registry";
import { SITE_URL } from "@/lib/site";

/**
 * The public MCP reference: the page MCP registries and agent directories
 * link to, so its address is stable. Open to anyone and to crawlers under
 * the `/docs` prefix (lib/public-paths.ts), listed in the sitemap and
 * /llms.txt. Read per request like /docs, so the tool list is the deployed
 * registry.
 */

export const dynamic = "force-dynamic";

const TITLE = "MCP server - GetTrafficFast docs";
const DESCRIPTION =
  "Connect GetTrafficFast's MCP server from Claude, ChatGPT, Cursor, VS Code or any client: the address, sign-in, API keys, permissions, prompts, every tool, limits and error codes.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/docs/mcp` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "GetTrafficFast",
    type: "website",
    url: "/docs/mcp",
  },
};

export default function McpDocsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <LandingHeader />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-12 md:py-16">
          <div className="mb-10 max-w-[760px]">
            <p className="mb-2 text-sm text-muted-foreground">
              <Link href="/docs" className="underline underline-offset-4 hover:text-foreground">
                Docs
              </Link>{" "}
              / MCP
            </p>
            <h1 className="text-4xl font-bold mb-3">MCP server</h1>
            <p className="text-lg text-muted-foreground">
              Run GetTrafficFast from Claude, ChatGPT, Cursor, VS Code or any MCP client: how to connect, what each
              permission allows, every tool, and what the server answers when something is refused.
            </p>
          </div>
          <div className="grid gap-10 lg:grid-cols-[200px_minmax(0,760px)] lg:gap-14">
            <aside className="min-w-0">
              <DocsToc sections={MCP_DOC_SECTIONS} />
            </aside>
            <McpDocsContent areas={toolAreas(TOOLS.list())} limits={docsLimits()} />
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
