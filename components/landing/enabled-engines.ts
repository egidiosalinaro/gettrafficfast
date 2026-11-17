import { getCitationProviders } from "@/lib/providers/citations/registry";
import { toAnswerEngines, type AnswerEngine } from "@/components/landing/engines";

/**
 * The answer engines this deployment actually asks, read at request time from
 * the same registry the sweeps use. Server only: the landing and /pricing pass
 * the result down, so a page never names an engine that is switched off.
 */
export function enabledAnswerEngines(): AnswerEngine[] {
  return toAnswerEngines(getCitationProviders().map((provider) => provider.name));
}
