import { DiscoveryProvider } from "./types";
import { isRedditConfigured, RedditDiscoveryProvider } from "./reddit";
import { GitHubDiscoveryProvider, isGitHubDiscoveryEnabled } from "./github";
import { WebSearchDiscoveryProvider } from "./web-search";
import { getSerpProvider } from "@/lib/providers/serp/registry";

/**
 * Every configured discovery surface.
 *
 * A list, like the citation engines: surfaces are not interchangeable and are
 * never merged into one ranking. An empty list is a normal state, and the
 * sweep reports itself disabled rather than failing. Each provider degrades on
 * its own: a Reddit app that is not approved leaves Reddit to the web search,
 * a missing SERP key leaves GitHub on its own, and so on.
 *
 * Order matters for deduplication. The first sighting of a thread is the one
 * kept, so platform APIs — which know engagement and dates — come before the
 * web search, which knows a URL and a snippet.
 */

let cached: DiscoveryProvider[] | undefined;

export function getDiscoveryProviders(): DiscoveryProvider[] {
  if (cached !== undefined) return cached;

  const providers: DiscoveryProvider[] = [];

  if (isRedditConfigured()) {
    providers.push(
      new RedditDiscoveryProvider(
        process.env.REDDIT_CLIENT_ID as string,
        process.env.REDDIT_CLIENT_SECRET as string
      )
    );
  }

  // Free public API, opt-in like the others (PLACEMENTS_GITHUB=true or a
  // GITHUB_TOKEN): what it finds is judged by a paid model call.
  if (isGitHubDiscoveryEnabled()) {
    providers.push(new GitHubDiscoveryProvider(process.env.GITHUB_TOKEN || null));
  }

  // The SERP vendor is already an opt-in paid key (SERPER_API_KEY); reusing it
  // for discovery adds scopes, not a vendor.
  const serp = getSerpProvider();
  if (serp) providers.push(new WebSearchDiscoveryProvider(serp));

  cached = providers;
  return cached;
}

/** Test seam. */
export function setDiscoveryProviders(providers: DiscoveryProvider[] | undefined): void {
  cached = providers;
}
