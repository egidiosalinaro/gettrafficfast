import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepliesLoading } from "@/components/placements/replies-loading";

describe("RepliesLoading", () => {
  const html = renderToStaticMarkup(<RepliesLoading />);

  it("is centred in the screen and says what is happening, as a status", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-[60vh]");
    expect(html).toContain("items-center justify-center");
    expect(html).toContain("Loading replies");
  });

  it("shows the site's own mark, hidden from assistive tech, with an orbit that stops under reduced motion", () => {
    // A mask in the page's own colour, never an <img> that follows the phone's scheme.
    expect(html).toContain("url(/icon.svg)");
    expect(html).toContain("bg-foreground");
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("motion-reduce:animate-none");
  });
});
