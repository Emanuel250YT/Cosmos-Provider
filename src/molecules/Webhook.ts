/** Molecule: Webhook — an endpoint registered to receive signed events. */

import type { APIWebhook } from "@/types/index";
import { Base } from "@/molecules/Base";

export class Webhook extends Base<APIWebhook> {
  /** This webhook endpoint's id, when the API returns it. */
  get id(): string | undefined {
    return this.raw.webhookId;
  }

  /** URL Etherfuse sends signed notifications to. */
  get url(): string | undefined {
    return this.raw.url;
  }

  /**
   * HMAC secret (base64). Only present in the creation response!
   * Store it securely: it's never returned again.
   */
  get secret(): string | undefined {
    return this.raw.secret;
  }

  /** Deregisters this webhook endpoint. Throws if it has no `webhookId` (e.g. a hand-built object). */
  delete(): Promise<unknown> {
    if (!this.id) throw new Error("This webhook has no webhookId.");
    return this.client.webhooks.delete(this.id);
  }
}
