/** Organism: base manager — every manager shares the client and REST layer. */

import type { REST } from "@/atoms/REST";
import type { EtherfuseClient } from "@/client/EtherfuseClient";

export abstract class BaseManager {
  /** Client that owns this manager — both `rest` and any other shared dependencies come from here. */
  readonly client: EtherfuseClient;

  constructor(client: EtherfuseClient) {
    this.client = client;
  }

  /** Shortcut to the client's HTTP layer, so each manager doesn't need to keep its own reference. */
  protected get rest(): REST {
    return this.client.rest;
  }
}
