import fridayLogo from "../assets/friday.png";

interface AppLogoProps {
  size: number;
  alt?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: string | number;
  background?: string;
  padding?: number;
}

export default function AppLogo({
  size,
  alt = "Friday",
  borderColor = "rgba(46, 76, 59, 0.16)",
  borderWidth = 1,
  borderRadius = 18,
  background = "var(--friday-surface-strong)",
  padding = 6,
}: AppLogoProps) {
  return (
    <img
      src={fridayLogo}
      alt={alt}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "cover",
        display: "block",
        borderRadius,
        background,
        border: `${borderWidth}px solid ${borderColor}`,
        padding,
        boxSizing: "border-box",
      }}
    />
  );
}
