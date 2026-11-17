/**
 * The content column of a signed-in section, without any data: SiteSection
 * wraps a page in it, and the loading skeleton uses the same frame so the
 * placeholder sits exactly where the page will.
 *
 * Below `md` there is no sidebar: the column is full width and keeps room at
 * the bottom for the tab bar, and for the Getting started pill while it shows
 * (`pb-mobile-chrome`, app/globals.css).
 */
export function SectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col md:ml-48 pb-mobile-chrome">
      <div className="flex-1 p-4 md:p-6 overflow-auto">{children}</div>
    </div>
  );
}
