/**
 * A company's favicon, via Google's public favicon service.
 *
 * Chosen over fetching icons ourselves because the alternative is a crawler,
 * a cache and a fallback pipeline for what is decoration: the service already
 * handles all three and returns a neutral globe when a site has no icon, so
 * the layout never breaks on a missing one.
 *
 * Decoration is the point: the icon repeats the name next to it, so it is
 * hidden from assistive tech (empty alt) and lazy-loaded. Requested at 64px
 * and scaled down so it stays sharp on dense screens.
 *
 * In the dark theme it sits on a white chip: many favicons are a black glyph
 * on transparent (GitHub's, Medium's) and drew nothing on the dark page.
 */
export function Favicon({
  domain,
  size = 18,
  className = "",
}: {
  domain: string;
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external, tiny, lazy: next/image would add a remote-pattern config for no gain.
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={`inline-block rounded-sm dark:bg-white ${className}`}
    />
  );
}
