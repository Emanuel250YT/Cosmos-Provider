/** Error hierarchy for the provider-agnostic core. */

/** Base class for every error thrown by the ramp engine. */
export class CosmosError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A payment provider API call failed. */
export class ProviderError extends CosmosError {
  readonly provider: string;
  readonly status?: number;
  readonly body?: unknown;

  constructor(provider: string, message: string, details?: { status?: number; body?: unknown; cause?: unknown }) {
    super(`[${provider}] ${message}`, { cause: details?.cause });
    this.provider = provider;
    this.status = details?.status;
    this.body = details?.body;
  }
}

/** The rate oracle could not produce a price. */
export class OracleError extends CosmosError {}

/** The settlement adapter failed to move the crypto leg. */
export class SettlementError extends CosmosError {}

/** An incoming webhook failed signature verification. */
export class WebhookSignatureError extends CosmosError {}
