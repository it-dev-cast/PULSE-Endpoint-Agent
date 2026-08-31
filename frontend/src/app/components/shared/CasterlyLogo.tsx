import type { CSSProperties } from "react";
import casterlyLockup from "@/assets/casterly-logo.png";
import casterlyMark from "@/assets/casterly-mark.png";

const CASTERLY_PURPLE = "#524A9D";
const CASTERLY_PURPLE_ON_DARK = "#D4CFF0";

type CasterlyMarkProps = {
  size?: number;
  className?: string;
};

/** Real C mark cropped from the official Casterly lockup. */
export function CasterlyMark({ size = 28, className }: CasterlyMarkProps) {
  return (
    <img
      src={casterlyMark}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden
      draggable={false}
      style={{ width: size, height: size, objectFit: "contain", display: "block" }}
    />
  );
}

type CasterlyLogoProps = {
  variant?: "light" | "dark";
  layout?: "stacked" | "inline" | "lockup";
  width?: number;
  className?: string;
};

function wordmarkStyle(variant: "light" | "dark", fontSize: number): CSSProperties {
  return {
    fontWeight: 800,
    fontSize,
    letterSpacing: 0.55,
    color: variant === "dark" ? CASTERLY_PURPLE_ON_DARK : CASTERLY_PURPLE,
    lineHeight: 1,
    textTransform: "uppercase",
    fontFamily: "Inter, -apple-system, sans-serif",
    whiteSpace: "nowrap",
  };
}

/** Official Casterly brand: C mark plus the word CASTERLY. */
export function CasterlyLogo({
  variant = "light",
  layout = "stacked",
  width = 44,
  className,
}: CasterlyLogoProps) {
  if (layout === "lockup") {
    return (
      <img
        src={casterlyLockup}
        alt="CASTERLY"
        className={className}
        style={{ width, height: "auto", objectFit: "contain", display: "block" }}
        draggable={false}
      />
    );
  }

  if (layout === "inline") {
    const mark = Math.max(14, Math.round(width * 0.36));
    return (
      <div className={className} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <CasterlyMark size={mark} />
        <span style={wordmarkStyle(variant, Math.max(10, Math.round(mark * 0.72)))}>CASTERLY</span>
      </div>
    );
  }

  const fontSize = Math.max(8, Math.round(width * 0.2));
  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", gap: 4 }}
    >
      <img
        src={casterlyMark}
        alt=""
        aria-hidden
        draggable={false}
        style={{ width, height: width, objectFit: "contain", display: "block" }}
      />
      <span style={{ ...wordmarkStyle(variant, fontSize), textAlign: "center" }}>CASTERLY</span>
    </div>
  );
}
