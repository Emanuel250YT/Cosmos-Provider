/** Molecule: base structure — every structure keeps the raw payload. */

import type { EtherfuseClient } from "@/client/EtherfuseClient";

export abstract class Base<Raw extends object> {
  /** Client that created this structure. */
  readonly client: EtherfuseClient;
  /** Raw payload exactly as returned by the API. */
  readonly raw: Raw;

  constructor(client: EtherfuseClient, raw: Raw) {
    this.client = client;
    this.raw = raw;
  }

  /** `JSON.stringify(structure)` serializes the raw payload, not the computed getters. */
  toJSON(): Raw {
    return this.raw;
  }
}
