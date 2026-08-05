import type { CSSProperties } from "react";

/**
 * Common fluid "card screen" wrapper: fills its container down to small
 * viewports and caps out at a comfortable phone-sized reading width on
 * large ones, instead of the fixed 375px frame the source mockups used.
 */
export const screenCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  boxSizing: "border-box",
  margin: "0 auto",
};
