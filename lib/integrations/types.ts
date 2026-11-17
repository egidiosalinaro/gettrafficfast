/**
 * Stored integration records. The publishing behaviour that used to live here
 * now belongs to lib/publishing (adapters over the Canonical Article); this
 * module only describes what is persisted.
 */

export type IntegrationType = "wordpress" | "webflow" | "shopify" | "webhook";

export type IntegrationStatus = "connected" | "disconnected" | "error";

export interface IntegrationRow {
  id: string;
  user_id: string;
  business_id: string | null;
  type: IntegrationType;
  config: Record<string, unknown>;
  status: IntegrationStatus;
  last_error: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}
