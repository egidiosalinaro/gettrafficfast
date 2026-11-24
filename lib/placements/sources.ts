/**
 * Whether placement discovery can run for this deployment.
 *
 * Which surfaces are on is a platform setting (env vars), not something a
 * customer connects. The inbox therefore never lists providers or env vars:
 * Run discovery is enabled when at least one provider exists, and disabled
 * (with DISCOVERY_UNAVAILABLE) when none do. The operator map lives in
 * docs/PLACEMENTS.md.
 */

export const DISCOVERY_UNAVAILABLE =
  "Discovery is not searching yet. When it is on, the product looks for public conversations on Reddit, GitHub, LinkedIn and X that match this site's keywords. You still publish; nothing is posted on its own.";

export function describeDiscoverySources(providerNames: string[]): {
  canRun: boolean;
} {
  return { canRun: providerNames.length > 0 };
}
