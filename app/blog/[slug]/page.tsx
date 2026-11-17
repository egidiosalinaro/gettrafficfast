import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { LandingHeader } from "@/components/landing/header";
import { LandingFooter } from "@/components/landing/footer";
import { ArrowLeft } from "lucide-react";
import { getPost } from "@/lib/blog/posts";
import { decorateArticleBody } from "@/lib/blog/anatomy";
import { jsonLdScript, postJsonLd, postUrl, seoTitle } from "@/lib/blog/structured-data";
import { SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function loadSafely(slug: string) {
  try {
    return await getPost(slug);
  } catch (error) {
    console.error("blog: could not load post", error);
    return null;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await loadSafely(slug);
  if (!post) return { title: "Post not found - GetTrafficFast" };

  // No `images` here, on purpose: `opengraph-image.tsx` beside this page
  // generates the share card and Next adds it to og:image and twitter:image
  // on its own. Naming images in this object would replace that card. The
  // hero is stated where it belongs, in the Article JSON-LD.
  return {
    // The article's own meta title, else the headline cut at a word (lib/blog/structured-data.ts).
    title: seoTitle(post),
    description: post.metaDescription || undefined,
    alternates: { canonical: postUrl(post.slug) },
    openGraph: {
      title: post.metaTitle ?? post.title,
      description: post.metaDescription || undefined,
      siteName: SITE_NAME,
      type: "article",
      url: postUrl(post.slug),
      ...(post.date ? { publishedTime: post.date } : {}),
      ...(post.modified ? { modifiedTime: post.modified } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: post.metaTitle ?? post.title,
      description: post.metaDescription || undefined,
    },
  };
}

function formatDay(day: string | null): string | null {
  if (!day) return null;
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return null;
  // A stored day is a UTC day: formatted in UTC so it never reads a day early.
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = await loadSafely(slug);

  if (!post) {
    notFound();
  }

  const formatted = formatDay(post.date);
  // Shown only when the sender said the article changed after it was published.
  const updated = formatDay(post.modified);

  return (
    <div className="min-h-screen flex flex-col">
      {/*
        Article, FAQPage (when the article has an FAQ) and BreadcrumbList,
        built from the delivery's own fields (lib/blog/structured-data.ts).
      */}
      {postJsonLd(post).map((block) => (
        <script
          key={String(block["@type"])}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(block) }}
        />
      ))}
      <LandingHeader />
      <main className="flex-1">
        <article className="w-full max-w-4xl mx-auto px-5 py-20">
          <Link
            href="/blog"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Blog
          </Link>

          <header className="mb-8">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              {formatted && <time dateTime={post.date ?? undefined}>{formatted}</time>}
              {formatted && <span aria-hidden>•</span>}
              {updated && (
                <span>
                  Updated <time dateTime={post.modified ?? undefined}>{updated}</time>
                </span>
              )}
              {updated && <span aria-hidden>•</span>}
              {/* The business wrote it: no person is named, because there is none. */}
              <span>
                By{" "}
                <Link href="/" rel="author" className="underline underline-offset-2 hover:text-foreground">
                  {SITE_NAME}
                </Link>
              </span>
            </div>
          </header>

          {/*
            New deliveries put the hero in body_html (figure.gtf-hero) and set
            media.hero.embedded. Older rows may still carry a hero that is not
            in the body — render it here so those posts keep their photo.
          */}
          {post.hero && !post.hero.embedded && (
            <figure className="mb-8">
              <Image
                src={post.hero.url}
                alt={post.hero.alt}
                width={1200}
                height={630}
                className="w-full h-auto rounded-lg border"
                priority
              />
              {post.hero.caption && (
                <figcaption className="text-sm text-muted-foreground mt-2">
                  {post.hero.caption}
                </figcaption>
              )}
            </figure>
          )}

          {/*
            body_html is sanitised by lib/blog: on receive and again on read
            (sanitizeBlogHtml, the content pipeline's tag and attribute
            allowlist), so no script, handler or javascript: URL reaches this
            origin even if a stored row predates the receiver's check. It
            carries no <h1>: the title above is the document's only one.
            decorateArticleBody only marks the short version and wraps the
            Read next block for styling (lib/blog/anatomy.ts).
          */}
          <div
            className="blog-content max-w-none"
            dangerouslySetInnerHTML={{ __html: decorateArticleBody(post.bodyHtml) }}
          />

          <aside className="mt-16 rounded-lg border p-6">
            <p className="text-sm text-muted-foreground">
              This article was researched, written and published by
              GetTrafficFast, running on its own domain.{" "}
              <Link href="/" className="underline hover:opacity-70">
                See what it would write for you
              </Link>
              .
            </p>
          </aside>
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
