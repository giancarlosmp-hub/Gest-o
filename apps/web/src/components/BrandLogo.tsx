type LogoVariant = "light" | "dark";

type BrandLogoProps = {
  size?: "login" | "sidebar" | "header";
  variant?: LogoVariant;
  className?: string;
};

const sizeClasses = {
  login: "h-12 w-auto object-contain",
  sidebar: "h-9 w-auto object-contain",
  header: "h-8 w-auto object-contain",
} as const;

const getLogoSrc = (size: BrandLogoProps["size"], variant?: LogoVariant) => {
  const backgroundVariant = variant ?? (size === "sidebar" ? "dark" : "light");

  return backgroundVariant === "dark"
    ? "/logo-demetra-light.svg"
    : "/logo-demetra-dark.svg";
};

export default function BrandLogo({ size = "sidebar", variant, className = "" }: BrandLogoProps) {
  return (
    <img
      src={getLogoSrc(size, variant)}
      alt="Demetra Agro Performance"
      className={`${sizeClasses[size]} ${className}`.trim()}
      draggable={false}
    />
  );
}
