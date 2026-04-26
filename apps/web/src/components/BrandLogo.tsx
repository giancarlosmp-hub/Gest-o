type BrandLogoProps = {
  context?: "login" | "sidebar" | "header";
  tone?: "light" | "dark";
  compact?: boolean;
  showText?: boolean;
  textClassName?: string;
  className?: string;
};

const logoByTone: Record<NonNullable<BrandLogoProps["tone"]>, string> = {
  dark: "/brand/demetra-logo-dark.svg",
  light: "/brand/demetra-logo-light.svg",
};

const imageClassByContext: Record<NonNullable<BrandLogoProps["context"]>, string> = {
  login: "h-12 w-auto object-contain",
  header: "h-8 w-auto object-contain",
  sidebar: "h-8 w-auto object-contain",
};

export default function BrandLogo({
  context = "sidebar",
  tone = "light",
  compact = false,
  showText = true,
  textClassName = "text-current",
  className = "",
}: BrandLogoProps) {
  const shouldShowText = showText && !compact;

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <img src={logoByTone[tone]} alt="Marca Demetra" className={imageClassByContext[context]} />
      {shouldShowText ? (
        <div className={`leading-tight ${textClassName}`.trim()}>
          <p className="text-sm font-semibold">Demetra</p>
          <p className="text-xs">Agro Performance</p>
        </div>
      ) : null}
    </div>
  );
}
