import { ImageResponse } from "next/og";
import { OG_CARD_SIZE, OG_FALLBACK_TITLE, ogCardTitle, ogTitleFontSize } from "@/lib/blog/og-card";
import { getPost } from "@/lib/blog/posts";
import { SITE_NAME, SITE_URL } from "@/lib/site";

/**
 * The social card of a blog post: its title on the site's own background,
 * with the site name. Drawn in code, on request, with no model call and no
 * stored file, so it costs nothing per article and can never be an
 * AI-looking picture with letter-shaped noise in it.
 *
 * Next picks this file up as the post's `og:image` (and its width, height
 * and type) on its own; `page.tsx` must not set `openGraph.images`, which
 * would replace it.
 *
 * Colours are the site's defaults (app/globals.css, light theme): a blog
 * post carries no palette of its own. The font is the one `next/og` ships.
 */

export const alt = `${SITE_NAME} blog post`;
export const size = { width: OG_CARD_SIZE.width, height: OG_CARD_SIZE.height };
export const contentType = "image/png";

// Reads the post with the admin client, like the page does.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKGROUND = "#fafafa";
const FOREGROUND = "#353331";
const INK = "#171717";
const MUTED = "#6b6965";

const HOST = new URL(SITE_URL).host;

async function titleOf(slug: string): Promise<string> {
  try {
    const post = await getPost(slug);
    return ogCardTitle(post?.title);
  } catch (error) {
    console.error("blog: could not load post for its social card", error);
    return OG_FALLBACK_TITLE;
  }
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shown = await titleOf(slug);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: BACKGROUND,
          color: FOREGROUND,
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              backgroundColor: INK,
              marginRight: 16,
            }}
          />
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, color: INK }}>{SITE_NAME}</div>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: ogTitleFontSize(shown),
            fontWeight: 700,
            lineHeight: 1.12,
            letterSpacing: "-0.02em",
            color: INK,
          }}
        >
          {shown}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `2px solid ${INK}`,
            paddingTop: 24,
            fontSize: 28,
            color: MUTED,
          }}
        >
          <div style={{ display: "flex" }}>Blog</div>
          <div style={{ display: "flex" }}>{HOST}</div>
        </div>
      </div>
    ),
    size
  );
}
