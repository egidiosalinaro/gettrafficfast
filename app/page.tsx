import { LandingHeader } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { ProductPreview } from "@/components/landing/product-preview";
import { DailyUse } from "@/components/landing/daily-use";
import { AISearch } from "@/components/landing/ai-search";
import { Features } from "@/components/landing/features";
import { Languages } from "@/components/landing/languages";
import { Examples } from "@/components/landing/examples";
import { Pricing } from "@/components/landing/pricing";
import { FAQ } from "@/components/landing/faq";
import { LandingFooter } from "@/components/landing/footer";
import { enabledAnswerEngines } from "@/components/landing/enabled-engines";

// The examples section reads the blog at request time, so the page cannot be
// a build-time static file: a new article must show up without a redeploy.
export const dynamic = "force-dynamic";

export default function Home() {
  // Read per request, like the blog: an engine switched on or off on the
  // server must change what the page names without a redeploy.
  const engines = enabledAnswerEngines();

  return (
    <div className="min-h-screen flex flex-col">
      <LandingHeader />
      <main className="flex-1">
        <Hero engines={engines} />
        <ProductPreview />
        <DailyUse engines={engines} />
        <AISearch engines={engines} />
        <Features />
        <Languages />
        <Examples />
        <Pricing engines={engines} />
        <FAQ engines={engines} />
      </main>
      <LandingFooter />
    </div>
  );
}
