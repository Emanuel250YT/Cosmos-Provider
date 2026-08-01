/** Organism: manager base — todos los managers comparten cliente y REST. */

import type { REST } from "@/atoms/REST";
import type { EtherfuseClient } from "@/client/EtherfuseClient";

export abstract class BaseManager {
  readonly client: EtherfuseClient;

  constructor(client: EtherfuseClient) {
    this.client = client;
  }

  protected get rest(): REST {
    return this.client.rest;
  }
}
