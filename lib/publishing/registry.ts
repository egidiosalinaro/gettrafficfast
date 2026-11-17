import { decryptSecret } from "@/lib/integrations/crypto";
import { IntegrationRow } from "@/lib/integrations/types";
import { PublisherAdapter } from "./types";
import { WebhookAdapter } from "./adapters/webhook";
import { WordPressAdapter } from "./adapters/wordpress";
import { resolveWebhookSecret } from "./webhook-secret";

/**
 * Maps a stored integration to its adapter, decrypting credentials on the way.
 * The only place that knows which destinations exist.
 */
export function resolveAdapter(integration: IntegrationRow): PublisherAdapter {
  switch (integration.type) {
    case "wordpress": {
      const config = integration.config as {
        site_url?: string;
        username?: string;
        application_password_encrypted?: string;
      };
      if (!config.site_url || !config.username || !config.application_password_encrypted) {
        throw new Error("WordPress integration is misconfigured");
      }
      return new WordPressAdapter({
        siteUrl: config.site_url,
        username: config.username,
        applicationPassword: decryptSecret(config.application_password_encrypted),
      });
    }
    case "webhook": {
      const config = integration.config as {
        url?: string;
        secret_encrypted?: string;
      };
      if (!config.url) {
        throw new Error("Webhook integration is misconfigured");
      }
      return new WebhookAdapter({
        url: config.url,
        secret: resolveWebhookSecret(config, integration.user_id),
      });
    }
    default:
      throw new Error(`Unsupported destination: ${integration.type}`);
  }
}
