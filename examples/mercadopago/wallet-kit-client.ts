/**
 * Browser-only entry point, bundled separately by demo-ui.tsx's
 * `getWalletKitBundle()` (esbuild, IIFE) and served at `/assets/wallet-kit.js`.
 * The wizard's "wallet" step calls `window.connectStellarWallet()` — this
 * opens Stellar Wallets Kit's own auth modal (wallet picker + connect +
 * fetch address in one call) instead of asking the buyer to type/paste an
 * address by hand.
 *
 * Only wallets that need no extra runtime config (no WalletConnect project
 * id, no hardware transport) are registered, so the demo works out of the
 * box: Freighter, xBull, Albedo, Rabet, Hana, Lobstr.
 */
import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";

StellarWalletsKit.init({
  network: Networks.TESTNET,
  modules: [new FreighterModule(), new xBullModule(), new AlbedoModule(), new RabetModule(), new HanaModule(), new LobstrModule()],
});

declare global {
  interface Window {
    connectStellarWallet: () => Promise<string>;
    signStellarTransaction: (xdr: string, address: string, networkPassphrase: string) => Promise<string>;
  }
}

window.connectStellarWallet = async function connectStellarWallet(): Promise<string> {
  const { address } = await StellarWalletsKit.authModal();
  return address;
};

/**
 * Signs an unsigned transaction XDR with whichever wallet the user connected
 * via connectStellarWallet() above — used by the wallet step's "enable
 * trustline" prompt (see demo-ui.tsx's ensureTrustline()) to open the demo's
 * USDC trustline without the server ever touching this wallet's private key.
 * Throws if the user rejects the signature request in their wallet, or if no
 * wallet is connected (e.g. a manually-pasted address, which has no signer).
 */
window.signStellarTransaction = async function signStellarTransaction(xdr: string, address: string, networkPassphrase: string): Promise<string> {
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, { address, networkPassphrase });
  return signedTxXdr;
};
