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
  borderColor = "#2C2C2C",
  borderWidth = 2,
  borderRadius = "50%",
  background = "#FFFFFF",
  padding = 4,
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
