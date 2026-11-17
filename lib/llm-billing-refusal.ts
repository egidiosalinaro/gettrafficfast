import type { SupabaseClient } from "@supabase/supabase-js";
import { LLM_CREDITS_RAN_OUT_MESSAGE, recordLlmBillingRefusal } from "@/lib/llm-billing";
import { isLlmBillingRefusal } from "@/lib/providers/llm/types";

/**
 * A model call made inside a request (analyse a site, suggest keywords,
 * propose prompts) that every model account refused to pay for: recorded
 * the way the worker records it (pause, one alert), and answered as a 503
 * in words rather than the provider's error. Null for any other failure,
 * which the caller handles as before.
 *
 * Its own module so the routes and the tools share it, and so a test that
 * replaces `recordLlmBillingRefusal` sees the call.
 */

export interface InRequestBillingRefusal {
  ok: false;
  status: 503;
  error: string;
}

/** `admin` is called only for a billing refusal: the record is the service role's to write. */
export async function inRequestBillingRefusal(
  admin: () => SupabaseClient,
  error: unknown,
  source: string
): Promise<InRequestBillingRefusal | null> {
  if (!isLlmBillingRefusal(error)) return null;
  await recordLlmBillingRefusal(admin(), error, { source });
  return { ok: false, status: 503, error: LLM_CREDITS_RAN_OUT_MESSAGE };
}
