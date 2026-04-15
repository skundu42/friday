import fridayLogo from "../assets/friday.png";

interface AppLogoProps {
  size: number;
  alt?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: string | number;
  background?: string;
  padding?: number;
  imageOffsetX?: number;
  imageOffsetY?: number;
}

export default function AppLogo({
  size,
  alt = "Friday",
  borderColor = "rgba(46, 76, 59, 0.16)",
  borderWidth = 1,
  borderRadius = 18,
  background = "var(--friday-surface-strong)",
  padding = 6,
  imageOffsetX = 0,
  imageOffsetY = 0,
}: AppLogoProps) {
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius,
        background,
        border: `${borderWidth}px solid ${borderColor}`,
        padding,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <img
        src={fridayLogo}
        alt={alt}
        width={size}
        height={size}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          transform: `translate(${imageOffsetX}px, ${imageOffsetY}px)`,
        }}
      />
    </span>
  );
}
