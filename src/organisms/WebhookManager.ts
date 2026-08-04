/** Organism: WebhookManager — `client.webhooks` (endpoint management). */

import { Routes } from "@/atoms/constants";
import { Webhook } from "@/molecules/Webhook";
import type { APIWebhook, CreateWebhookOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class WebhookManager extends BaseManager {
  /**
   * Registers a webhook. The response includes `secret` (base64) ONLY ONCE:
   * store it to verify signatures with `cosmos-providers/webhooks`.
   */
  async create(options: CreateWebhookOptions): Promise<Webhook> {
    const raw = await this.rest.post<APIWebhook>(Routes.webhook(), options);
    return new Webhook(this.client, raw);
  }

  /** A webhook endpoint by id. The response does NOT include `secret` (only shown once, on creation). */
  async fetch(webhookId: string): Promise<Webhook> {
    const raw = await this.rest.get<APIWebhook>(Routes.webhookById(webhookId));
    return new Webhook(this.client, raw);
  }

  /** Lists all registered webhook endpoints. */
  async list(): Promise<Webhook[]> {
    const raw = await this.rest.get<APIWebhook[] | { items?: APIWebhook[] }>(Routes.webhooks());
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items.map((w) => new Webhook(this.client, w));
  }

  /** Deregisters a webhook endpoint. */
  delete(webhookId: string): Promise<unknown> {
    return this.rest.delete(Routes.webhookById(webhookId));
  }
}
