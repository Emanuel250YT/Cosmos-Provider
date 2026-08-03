/** Molecule: estructura base — todas las estructuras guardan el payload crudo. */

import type { EtherfuseClient } from "@/client/EtherfuseClient";

export abstract class Base<Raw extends object> {
  /** Client that created this structure. */
  readonly client: EtherfuseClient;
  /** Payload crudo tal cual lo devolvió la API. */
  readonly raw: Raw;

  constructor(client: EtherfuseClient, raw: Raw) {
    this.client = client;
    this.raw = raw;
  }

  toJSON(): Raw {
    return this.raw;
  }
}
