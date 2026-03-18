type BrandLogoProps = {
  size?: "login" | "sidebar" | "header";
  textClassName?: string;
  className?: string;
};

const brandLogoBySize: Record<
  NonNullable<BrandLogoProps["size"]>,
  { src: string; className: string }
> = {
  login: {
    src: "/logo-demetra-dark.svg",
    className: "h-12 w-auto object-contain",
  },
  header: {
    src: "/logo-demetra-dark.svg",
    className: "h-8 w-auto object-contain",
  },
  sidebar: {
    src: "/brand/demetra-logo-light.svg",
    className: "h-8 w-auto object-contain",
  },
};

export default function BrandLogo({
  size = "sidebar",
  textClassName = "text-current",
  className = "",
}: BrandLogoProps) {
  const logo = brandLogoBySize[size];

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <img
        src={logo.src}
        alt="Logo Demetra Agro Performance"
        className={logo.className}
      />
      <div className={`leading-tight ${textClassName}`.trim()}>
        <p className="text-sm font-semibold">Demetra</p>
        <p className="text-xs">Agro Performance</p>
      </div>
    </div>
  );
}
