/** Organism: manager base — todos los managers comparten cliente y REST. */

import type { REST } from "@/atoms/REST";
import type { EtherfuseClient } from "@/client/EtherfuseClient";

export abstract class BaseManager {
  /** Cliente dueño de este manager — de acá salen tanto `rest` como las demás dependencias compartidas. */
  readonly client: EtherfuseClient;

  constructor(client: EtherfuseClient) {
    this.client = client;
  }

  /** Atajo a la capa HTTP del cliente, para que cada manager no tenga que guardar su propia referencia. */
  protected get rest(): REST {
    return this.client.rest;
  }
}
