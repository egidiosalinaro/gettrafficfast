import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Enqueuing. Producers (the cron, a route, later an MCP tool) never execute
 * work — they record the intent and return.
 */

export interface EnqueueInput {
  supabase: SupabaseClient;
  userId: string;
  /** The site this work is for. Null only for rows that predate business tenancy. */
  businessId?: string | null;
  type: string;
  input?: Record<string, unknown>;
  articleId?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(params: EnqueueInput): Promise<string> {
  const { supabase, userId, businessId = null, type, input = {}, articleId = null } = params;

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      user_id: userId,
      business_id: businessId,
      type,
      input,
      article_id: articleId,
      priority: params.priority ?? 0,
      run_after: (params.runAfter ?? new Date()).toISOString(),
      max_attempts: params.maxAttempts ?? 3,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to enqueue "${type}": ${error.message}`);
  return data.id as string;
}

/**
 * True when the article already has work queued or running, so a second click
 * (or a cron overlapping a manual run) cannot start the same production twice.
 */
export async function hasActiveJob(
  supabase: SupabaseClient,
  articleId: string,
  type: string
): Promise<boolean> {
  const { count } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("article_id", articleId)
    .eq("type", type)
    .in("status", ["pending", "running"]);
  return (count ?? 0) > 0;
}

/** True when this site already has this job type queued or running. */
export async function hasActiveBusinessJob(
  supabase: SupabaseClient,
  businessId: string,
  type: string
): Promise<boolean> {
  const { count } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("type", type)
    .in("status", ["pending", "running"]);
  return (count ?? 0) > 0;
}
