import { z } from "zod";
import { LlmError, LlmStructuredResult, LlmUsage } from "./types";

/**
 * Structured output over a plain completion, shared by every provider.
 *
 * The schema travels in the prompt AND is enforced on the way back: the model
 * is asked for a shape, but only validation decides whether it produced one.
 */

export type JsonCompletion = (prompt: string) => Promise<{ text: string; usage: LlmUsage }>;

/** Strips a ``` fence the model sometimes wraps JSON in. */
export function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak === -1) return trimmed;
  const rest = trimmed.slice(firstBreak + 1);
  const closing = rest.lastIndexOf("```");
  return (closing === -1 ? rest : rest.slice(0, closing)).trim();
}

function addUsage(total: LlmUsage | null, next: LlmUsage): LlmUsage {
  if (!total) return next;
  return {
    model: next.model,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    costUsd: total.costUsd + next.costUsd,
  };
}

export async function completeStructured<T>(
  complete: JsonCompletion,
  prompt: string,
  schema: z.ZodType<T>,
  vendor: { provider: string; label: string }
): Promise<LlmStructuredResult<T>> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
  const instructed = `${prompt}

Respond with JSON only — no prose, no code fences — matching this JSON Schema exactly:
${jsonSchema}`;

  let lastRaw = "";
  let lastIssue = "";
  // Both attempts were paid for, so both are charged to the run's budget.
  let usage: LlmUsage | null = null;

  // One retry: a schema violation is usually a formatting slip, and repeating
  // the requirement with the specific error fixes it far more often than not.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint =
      attempt === 1
        ? ""
        : `\n\nYour previous response did not match the schema (${lastIssue}). Return corrected JSON only.`;
    const result = await complete(instructed + retryHint);
    usage = addUsage(usage, result.usage);
    lastRaw = result.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(unfence(result.text));
    } catch {
      lastIssue = "response was not valid JSON";
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) {
      return { value: validated.data, usage, raw: result.text };
    }
    lastIssue = validated.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
  }

  throw new LlmError(
    `${vendor.label} returned a response that does not match the expected schema (${lastIssue})`,
    vendor.provider,
    { raw: lastRaw.slice(0, 500), usage }
  );
}
