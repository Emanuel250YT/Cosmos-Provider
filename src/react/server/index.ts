/**
 * cosmos-providers/react/server — server-only companion to
 * `cosmos-providers/react`.
 *
 * Import this from a server context (an API route, a Server Component, a
 * plain Node script) right after calling into `CosmosRamp`/`CosmosClient`/
 * `EtherfuseClient` — those calls need API keys and must never run in the
 * browser. The functions here turn their responses into the plain,
 * serializable props the presentational components in
 * `cosmos-providers/react` accept, so nothing secret ever has to reach the
 * client — only the already-public payment payload (QR string, amounts,
 * status) does.
 */

export { renderQrDataUrl, renderQrSvg } from "./qr";
export type { QrRenderOptions } from "./qr";

export {
  quoteToSummaryRows,
  rampOrderToDetailRows,
  chargeToQrProps,
  depositInstructionsToQrProps,
  apiOrderToDetailRows,
} from "./viewModels";
