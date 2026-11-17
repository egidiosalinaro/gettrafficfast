import Link from "next/link";
import type { ReactNode } from "react";
import { formatLegalDate, LEGAL_LAST_UPDATED } from "@/lib/legal";

/**
 * The frame of the legal pages: a title, the fixed "Last updated" date
 * (lib/legal.ts, never the render date), a list of anchors, then the
 * sections, each reachable at `#<id>`. Plain markup, one column, readable on
 * a phone. The texts themselves live in app/privacy-policy and
 * app/terms-and-conditions.
 */

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

export function LegalPage({ title, intro, sections }: { title: string; intro: ReactNode; sections: LegalSection[] }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
        <Link href="/" className="mb-8 inline-block text-xl font-bold">
          GetTrafficFast
        </Link>

        <h1 className="mb-3 text-3xl font-bold sm:text-4xl">{title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Last updated: <time dateTime={LEGAL_LAST_UPDATED}>{formatLegalDate()}</time>
        </p>

        <div className="space-y-4 text-base leading-relaxed text-foreground/85">{intro}</div>

        <nav aria-label="On this page" className="mt-8 rounded-lg border p-4">
          <p className="mb-2 text-sm font-semibold">On this page</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-4">
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} className="scroll-mt-6 pt-8">
              <h2 className="mb-3 text-xl font-semibold sm:text-2xl">
                <a href={`#${section.id}`} className="hover:underline underline-offset-4">
                  {index + 1}. {section.title}
                </a>
              </h2>
              <div className="space-y-3 text-base leading-relaxed text-foreground/85 [overflow-wrap:anywhere]">
                {section.body}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12 border-t pt-8">
          <Link href="/" className="text-primary hover:underline">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      className="text-primary underline underline-offset-4"
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}
