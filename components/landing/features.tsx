import { SUPPORTED_CONTENT_LANGUAGES } from "@/lib/content-language";

export function Features() {
  return (
    <section className="w-full max-w-[1200px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">The page that should get cited</h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          Once a prompt shows you were not the source, this is the pipeline
          that writes and publishes the page. Each step runs today.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Auto keywords</h3>
          <p className="text-foreground/70 text-sm">
            The agent reads your site, describes your business and proposes a
            keyword list for your niche, each with an estimated volume,
            competition and difficulty. They are model estimates, not numbers
            bought from a data vendor.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Auto research</h3>
          <p className="text-foreground/70 text-sm">
            Before writing, the current Google results for the keyword are
            read and analysed: the titles and snippets that rank, the questions
            people also ask. The article is planned against what it has to beat
            instead of against a blank page.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Auto linking</h3>
          <p className="text-foreground/70 text-sm">
            Every article records what it is about, and the next one links back
            to the ones that fit. Anchors are verified against the text, so a
            link never points somewhere the sentence did not promise.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Auto images and video</h3>
          <p className="text-foreground/70 text-sm">
            With media enabled, images are generated for the article&rsquo;s own
            sections and stored on the platform, and a relevant YouTube video is
            selected when one genuinely fits. Off by default, because it costs
            money per article.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Your business in frame</h3>
          <p className="text-foreground/70 text-sm">
            Articles are written from your business description and end on a
            call to action. The writer is explicitly forbidden from inventing
            statistics, quotes, prices or features you never claimed.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Quality gates</h3>
          <p className="text-foreground/70 text-sm">
            Nothing reaches your site unchecked: structure, headings, length,
            markup and links are validated first, and an article that fails is
            held back and reported rather than published broken.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Autopilot</h3>
          <p className="text-foreground/70 text-sm">
            An empty day cannot be recovered later, so the calendar is kept
            filled ahead and the keyword pool is topped up before it runs dry.
            Threshold-based: away for a month, you do not come back to thirty
            articles nobody asked for.
          </p>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Multi language</h3>
          <p className="text-foreground/70 text-sm mb-4">
            {SUPPORTED_CONTENT_LANGUAGES.length} languages today, picked per
            business and independent of the language your site is written in.
          </p>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_CONTENT_LANGUAGES.map((language) => (
              <span key={language.code} className="text-xs px-2 py-1 bg-muted rounded">
                {language.label}
              </span>
            ))}
          </div>
        </div>

        <div className="p-6 rounded-lg border bg-card">
          <h3 className="text-xl font-semibold mb-3">Publishing</h3>
          <p className="text-foreground/70 text-sm mb-4">
            Connect WordPress directly, or receive a webhook and publish on any
            stack. A failed delivery is retried on the next run, and you get
            an email the first time the connection fails.
          </p>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2 py-1 bg-muted rounded">WordPress</span>
            <span className="text-xs px-2 py-1 bg-muted rounded">Webhook</span>
            <span className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
              Webflow, Shopify: not yet
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
