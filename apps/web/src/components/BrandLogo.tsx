type BrandLogoProps = {
  size?: "login" | "sidebar" | "header";
  textClassName?: string;
  className?: string;
};

const sizeClasses = {
  login: "h-12",
  sidebar: "h-8",
  header: "h-8",
};

const logoSrcBySize: Record<NonNullable<BrandLogoProps["size"]>, string> = {
  login: "/logo-demetra-dark.svg",
  header: "/logo-demetra-dark.svg",
  sidebar: "/brand/demetra-logo-light.svg",
};

export default function BrandLogo({
  size = "sidebar",
  textClassName = "text-current",
  className = "",
}: BrandLogoProps) {
  const logoSrc = logoSrcBySize[size];

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <img
        src={logoSrc}
        alt="Logo Demetra Agro Performance"
        className={`${sizeClasses[size]} w-auto object-contain`}
      />
      <div className={`leading-tight ${textClassName}`.trim()}>
        <p className="text-sm font-semibold">Demetra</p>
        <p className="text-xs">Agro Performance</p>
      </div>
    </div>
  );
}