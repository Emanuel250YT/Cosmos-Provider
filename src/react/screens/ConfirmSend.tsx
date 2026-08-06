import { TransferPartyRow } from "../primitives/TransferPartyRow";
import { screenCardStyle } from "./shared";
import { t, type Locale } from "../i18n";

export interface ConfirmSendProps {
  senderAmount: string;
  recipientHandle: string;
  recipientAmount: string;
  walletAddress: string;
  network: string;
  transactionFeeLabel?: string;
  onBack?: () => void;
  onConfirm?: () => void;
  locale?: Locale;
}

/** Confirms a crypto send: sender → recipient, wallet/network details, fee. */
export function ConfirmSend({
  locale = "en",
  senderAmount,
  recipientHandle,
  recipientAmount,
  walletAddress,
  network,
  transactionFeeLabel = t(locale, "freeFee"),
  onBack,
  onConfirm,
}: ConfirmSendProps) {
  return (
    <div style={{ ...screenCardStyle, fontFamily: "Helvetica, Arial, sans-serif", background: "#EEF0F2", borderRadius: 24, padding: 20, color: "#111827", display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={onBack}
        aria-label={t(locale, "back")}
        style={{ width: 36, height: 36, borderRadius: "50%", background: "#fff", border: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, marginBottom: 16, cursor: onBack ? "pointer" : "default" }}
      >
        ←
      </button>

      <div style={{ fontSize: 24, fontWeight: 800, textAlign: "center", marginBottom: 20 }}>{t(locale, "confirmSend")}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, background: "#fff", borderRadius: 16, padding: 6, position: "relative" }}>
        <TransferPartyRow role={t(locale, "sendRole")} partyName={t(locale, "fromYou")} amount={senderAmount} />
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "#F3F4F6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%,-50%)",
            border: "4px solid #fff",
          }}
        >
          ↓
        </div>
        <TransferPartyRow role={t(locale, "receiveRole")} partyName={`${t(locale, "toPrefix")} ${recipientHandle}`} amount={recipientAmount} />
      </div>

      <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12, color: "#9CA3AF" }}>{t(locale, "walletAddress")}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{walletAddress}</span>
        </div>
        <div style={{ borderTop: "1px solid #F0F0F1" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 12, color: "#9CA3AF" }}>{t(locale, "network")}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{network}</span>
        </div>
        <div style={{ borderTop: "1px solid #F0F0F1" }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, color: "#9CA3AF" }}>{t(locale, "transactionFee")}</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{transactionFeeLabel}</span>
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onConfirm}
        style={{ width: "100%", background: "#111827", color: "#fff", border: "none", borderRadius: 16, padding: 16, fontSize: 16, fontWeight: 700, marginTop: 16, cursor: "pointer" }}
      >
        {t(locale, "confirmSend")}
      </button>
    </div>
  );
}
