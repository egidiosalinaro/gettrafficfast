import { AnthropicProvider } from "./anthropic";
import { FallbackProvider } from "./fallback";
import { GeminiProvider } from "./gemini";
import { LLMProvider, LlmArm, LlmError, LlmRole } from "./types";

/**
 * Resolves the configured LLM provider. The only place a vendor is chosen.
 *
 * LLM_PROVIDER picks the primary (gemini by default). LLM_FALLBACK names a
 * second provider that takes any request the primary failed, including the
 * primary's key not being set. It is opt-in like every other cost: a key
 * being present is not consent to spend on it.
 *
 * A role can have its own primary: `LLM_WRITER_PROVIDER=anthropic` sends the
 * article writer and its revision to Claude first while every other agent
 * stays on the default, which then stands behind the writer as its fallback.
 * Naming the provider in that variable is the consent to spend on it.
 *
 * `LLM_ARTICLE_ROTATION` (a comma list, `gemini,anthropic`) alternates the
 * article agents between providers day by day, so their work can be compared
 * task by task (docs/AGENT_RUNTIME.md, "The article rotation"). The provider
 * of the UTC day is every article agent's primary and the next one in the
 * list stands behind it. A production job is given its arm once
 * (`chooseArticleArm`) and hands it back on every call, so an article that
 * resumes after midnight stays on the provider it started with. While the
 * rotation is set it decides for the article agents and `LLM_WRITER_PROVIDER`
 * is ignored for them. Naming a provider in the list is the consent to spend
 * on it.
 */

const ROLE_ENV: Record<LlmRole, string> = { writer: "LLM_WRITER_PROVIDER" };
const ROTATION_ENV = "LLM_ARTICLE_ROTATION";
const KNOWN_PROVIDERS: readonly string[] = ["gemini", "anthropic"];
const DAY_MS = 86_400_000;

const cached = new Map<string, LLMProvider>();
let override: LLMProvider | null = null;
let rotationLogged = false;

function providerName(value: string | null | undefined): string {
  const name = (value ?? "").trim().toLowerCase();
  return name === "claude" ? "anthropic" : name;
}

function build(name: string): LLMProvider {
  switch (name) {
    case "gemini":
      return new GeminiProvider(process.env.GEMINI_API_KEY ?? "");
    case "anthropic":
      return new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? "");
    default:
      throw new LlmError(`Unknown LLM provider: ${name}`, name, undefined, { retryable: false });
  }
}

/**
 * The rotation as configured: provider names in order, or null when the
 * variable is unset or empty. A name this registry cannot build is refused
 * here, with the variable named, rather than on the day its turn comes.
 */
export function articleRotation(raw: string | undefined = process.env[ROTATION_ENV]): string[] | null {
  const names = (raw ?? "")
    .split(",")
    .map((item) => providerName(item))
    .filter(Boolean);
  if (names.length === 0) return null;
  for (const name of names) {
    if (!KNOWN_PROVIDERS.includes(name)) {
      throw new LlmError(
        `Unknown LLM provider in ${ROTATION_ENV}: "${name}". Use a comma list of: ${KNOWN_PROVIDERS.join(", ")}.`,
        name,
        undefined,
        { retryable: false }
      );
    }
  }
  return names;
}

/**
 * The arm for a job that starts now: the rotation's entry for the UTC day,
 * index = (days since 1970-01-01 UTC) mod (list length). `{ arm: null }`
 * when no rotation is configured. The caller stores the answer with the job
 * and passes `arm` back to `getLlmProvider`.
 */
export function chooseArticleArm(now: Date = new Date()): LlmArm {
  const rotation = articleRotation();
  if (!rotation) return { arm: null };
  const dayNumber = Math.floor(now.getTime() / DAY_MS);
  return {
    arm: rotation[dayNumber % rotation.length],
    day: new Date(dayNumber * DAY_MS).toISOString().slice(0, 10),
    rotation,
  };
}

function baseChain(): string[] {
  const primary = providerName(process.env.LLM_PROVIDER) || "gemini";
  const fallback = providerName(process.env.LLM_FALLBACK);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

/**
 * The chain for an article agent on `arm`, or null when the arm does not
 * apply: no rotation is configured now, or the arm is no longer in it. The
 * variable is the consent, so taking a provider out of it stops the spend
 * for jobs already under way too.
 */
function armChain(arm: string | null | undefined): string[] | null {
  const name = providerName(arm);
  if (!name) return null;
  const rotation = articleRotation();
  if (!rotation || !rotation.includes(name)) return null;
  // The next different provider in the rotation stands behind the arm; with
  // a list of one, whoever the default chain offers that is not the arm.
  const start = rotation.indexOf(name);
  const behind =
    [...rotation.slice(start + 1), ...rotation.slice(0, start)].find((candidate) => candidate !== name) ??
    baseChain().find((candidate) => candidate !== name);
  return behind ? [name, behind] : [name];
}

/**
 * The provider chain as names: first the one asked, then whoever stands
 * behind it. With an `arm` the rotation decides (and the role's own variable
 * is ignored); without one, the role's provider or the default.
 */
export function llmChain(role?: LlmRole, arm?: string | null): string[] {
  const rotated = armChain(arm);
  if (rotated) {
    if (!rotationLogged) {
      rotationLogged = true;
      const writer = providerName(process.env[ROLE_ENV.writer]);
      console.log(
        JSON.stringify({
          level: "info",
          event: "llm.article_rotation",
          rotation: articleRotation(),
          arm: rotated[0],
          fallback: rotated[1] ?? null,
          ...(writer ? { ignored: `${ROLE_ENV.writer}=${writer}` } : {}),
        })
      );
    }
    return rotated;
  }

  const base = baseChain();
  const roleName = role ? providerName(process.env[ROLE_ENV[role]]) : "";
  if (!roleName || roleName === base[0]) return base;
  // The role's own provider first; the default primary stands behind it.
  return [roleName, base[0]];
}

/**
 * `role` is who is asking; `arm` is what a production job was given by
 * `chooseArticleArm`. Everything that is not article production passes
 * neither, or a role alone, and is untouched by the rotation.
 */
export function getLlmProvider(role?: LlmRole, arm?: string | null): LLMProvider {
  if (override) return override;

  const chain = llmChain(role, arm);
  const key = chain.join(">");
  const existing = cached.get(key);
  if (existing) return existing;

  const [first, second] = chain;
  const provider = second
    ? new FallbackProvider(
        { name: first, build: () => build(first) },
        { name: second, build: () => build(second) }
      )
    : build(first);
  cached.set(key, provider);
  return provider;
}

/** Test seam: lets a suite run agents against a stub without network access. */
export function setLlmProvider(provider: LLMProvider | null): void {
  override = provider;
  cached.clear();
  rotationLogged = false;
}
