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

const logoSources: Record<LogoVariant, string> = {
  light: "/logo-demetra-light.svg",
  dark: "/logo-demetra-dark.svg",
};

export default function BrandLogo({ size = "sidebar", variant = "dark", className = "" }: BrandLogoProps) {
  return (
    <img
      src={logoSources[variant]}
      alt="Demetra Agro Performance"
      className={`${sizeClasses[size]} ${className}`.trim()}
      draggable={false}
    />
  );
}
