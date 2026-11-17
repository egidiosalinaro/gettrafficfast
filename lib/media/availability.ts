import { getVideoProvider } from "@/lib/providers/video/registry";

/**
 * Whether the platform can look for videos at all. Server-only (it reads the
 * provider registry), which is why it is not in `settings.ts`: the settings
 * form imports that file into the browser.
 *
 * The settings screen asks this before offering the videos switch. For
 * months the switch was there, businesses turned it on, and every article
 * recorded "no video provider configured": a control that did nothing.
 */
export function videoEnrichmentAvailable(): boolean {
  return getVideoProvider() !== null;
}
