import { SUPPORTED_CONTENT_LANGUAGES } from "@/lib/content-language";

/**
 * The languages the product actually generates in — the same list the Business
 * settings page offers, read from the single source of truth rather than typed
 * out again here. A flag list longer than that list is a promise the pipeline
 * cannot keep.
 */
const FLAGS: Record<string, string> = {
  en: "🇬🇧",
  it: "🇮🇹",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
};

export function Languages() {
  return (
    <section className="w-full max-w-[1200px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">
          Write in {SUPPORTED_CONTENT_LANGUAGES.length} languages
        </h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          The language of your articles is your choice, and it is independent of
          the language of your site: an Italian business can run an English blog
          to reach a market it does not sell in yet.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-4 mb-8">
        {SUPPORTED_CONTENT_LANGUAGES.map((language) => (
          <div
            key={language.code}
            className="flex items-center gap-2 px-5 py-3 rounded-lg border bg-card"
          >
            <span className="text-2xl">{FLAGS[language.code] ?? "🌍"}</span>
            <span className="text-sm">{language.label}</span>
          </div>
        ))}
      </div>

      <p className="text-center text-sm text-muted-foreground">
        Keywords, descriptions and articles are all generated in the language
        you pick. Need another one? Write and ask.
      </p>
    </section>
  );
}
