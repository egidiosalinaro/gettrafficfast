import { decryptSecret } from "@/lib/integrations/crypto";
import { isOwnWebhookReceiver } from "@/lib/site";
import { isOwnBlogOwner, OWN_BLOG_OWNER_ENV } from "./own-blog";

/**
 * The secret used to sign a webhook delivery.
 *
 * For a customer's site it is the value they pasted, stored encrypted.
 * For this site's own receiver it is BLOG_WEBHOOK_SECRET: one env var, not a
 * second copy in `integrations.config` that can drift from the receiver.
 *
 * Which of the two applies is decided from facts the user cannot write: the
 * URL being the own receiver, and the row's owner being an operator named in
 * OWN_BLOG_OWNER_USER_IDS. Nothing in `config` can opt a row into the env
 * secret. A legacy `secret_from_env` flag is ignored: it lives in a row the
 * owner of that row can edit, so trusting it would let any account sign
 * deliveries with the blog's secret.
 */
export function resolveWebhookSecret(
  config: {
    url?: string;
    secret_encrypted?: string;
  },
  ownerUserId: string | null | undefined
): string {
  const ownReceiver = typeof config.url === "string" && isOwnWebhookReceiver(config.url);

  if (ownReceiver) {
    if (!isOwnBlogOwner(ownerUserId)) {
      throw new Error(
        `This destination is reserved for the operator of this site (${OWN_BLOG_OWNER_ENV})`
      );
    }
    const env = process.env.BLOG_WEBHOOK_SECRET;
    if (!env) {
      throw new Error(
        "BLOG_WEBHOOK_SECRET is not set; cannot sign deliveries to this site's own receiver"
      );
    }
    return env;
  }

  if (!config.secret_encrypted) {
    throw new Error("Webhook integration is misconfigured");
  }
  return decryptSecret(config.secret_encrypted);
}
