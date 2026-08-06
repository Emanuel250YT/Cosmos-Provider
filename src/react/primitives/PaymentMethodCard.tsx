import type { ReactNode } from "react";

export interface PaymentMethodCardProps {
  iconLabel: string;
  iconBg: string;
  /** Logo image URL — shown instead of the `iconLabel` initials when set. */
  logoUrl?: string;
  /**
   * Set for a SQUARE logo, so it fills the whole circular badge edge to edge
   * instead of sitting inset on a white plate.
   *
   * The default treatment exists for wide/wordmark logos (Mercado Pago's,
   * say), which have to be letterboxed or they'd be cropped to an unreadable
   * middle slice. A square mark has nothing to crop — it already matches the
   * badge's aspect ratio — so inseting it just makes it look smaller than
   * its neighbours for no reason.
   */
  logoFills?: boolean;
  title: string;
  subtitle: string;
  selected?: boolean;
  radioColor?: string;
  bg?: string;
  /**
   * What this rail costs, shown on the trailing edge before the radio —
   * e.g. `"1.0%"` or `"2.0% spread"`. Whoever is listing providers usually
   * knows this (a static `feeLabel`, or the fee on a live quote); putting it
   * on the row is what lets someone pick the cheapest option for their
   * region without opening each one in turn.
   */
  feeLabel?: string;
  /** Small caption under `feeLabel`, e.g. `"per transaction"` or `"live"`. */
  feeCaption?: string;
  /** Small pill on the trailing edge, e.g. `"Coming soon"` or a network warning. */
  badge?: string;
  badgeColor?: string;
  /**
   * Renders the card as unavailable: dimmed, non-interactive, and with the
   * radio replaced by nothing. Use for a rail that's listed for
   * completeness but can't be chosen (not yet integrated, out of region,
   * temporarily out of liquidity) — `onSelect` is ignored entirely rather
   * than firing on a card the user was told they can't pick.
   */
  disabled?: boolean;
  /** Expanded content (e.g. an inline confirmation panel) shown below the card when selected. */
  children?: ReactNode;
  onSelect?: () => void;
}

/** A selectable payment/withdraw method card (radio row + icon badge, optionally a provider logo, its fee, and a status pill). */
export function PaymentMethodCard({
  iconLabel,
  iconBg,
  logoUrl,
  logoFills = false,
  title,
  subtitle,
  selected = false,
  radioColor = "var(--cosmos-radio, #D1D5DB)",
  bg = "var(--cosmos-panel, #fff)",
  feeLabel,
  feeCaption,
  badge,
  badgeColor = "#B45309",
  disabled = false,
  children,
  onSelect,
}: PaymentMethodCardProps) {
  const interactive = !!onSelect && !disabled;
  return (
    <div>
      <div
        onClick={interactive ? onSelect : undefined}
        role={interactive ? "button" : undefined}
        aria-disabled={disabled || undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: 16,
          borderRadius: 16,
          background: bg,
          fontFamily: "Helvetica, Arial, sans-serif",
          cursor: interactive ? "pointer" : disabled ? "not-allowed" : undefined,
          opacity: disabled ? 0.55 : undefined,
          filter: disabled ? "grayscale(1)" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              // A filling logo brings its own artwork edge to edge, so it
              // needs neither the white plate behind it nor the ring around
              // it — both would just draw a border over the image.
              background: logoUrl && !logoFills ? "#fff" : logoUrl ? undefined : iconBg,
              border: logoUrl && !logoFills ? "1px solid var(--cosmos-border, #E5E7EB)" : undefined,
              padding: logoUrl && !logoFills ? 6 : undefined,
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={title}
                // `cover` on a square source is a no-op crop (the aspect
                // ratios already match) but guarantees the circle is filled
                // if the file turns out slightly off-square.
                style={{ width: "100%", height: "100%", objectFit: logoFills ? "cover" : "contain", display: "block" }}
              />
            ) : (
              iconLabel
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--cosmos-fg, #111827)" }}>{title}</span>
            <span style={{ fontSize: 12, color: "var(--cosmos-muted, #9CA3AF)" }}>{subtitle}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {feeLabel || badge ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
              {feeLabel ? (
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cosmos-fg, #111827)", whiteSpace: "nowrap" }}>{feeLabel}</span>
              ) : null}
              {feeCaption ? (
                <span style={{ fontSize: 10, color: "var(--cosmos-muted, #9CA3AF)", whiteSpace: "nowrap", letterSpacing: ".02em" }}>{feeCaption}</span>
              ) : null}
              {badge ? (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".04em",
                    color: badgeColor,
                    background: `${badgeColor}1F`,
                    borderRadius: 999,
                    padding: "2px 7px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {badge}
                </span>
              ) : null}
            </div>
          ) : null}

          {disabled ? null : (
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: `2px solid ${radioColor}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {selected ? <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--cosmos-fg, #111827)" }} /> : null}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
