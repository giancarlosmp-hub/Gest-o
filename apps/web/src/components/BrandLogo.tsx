import { useMemo } from "react";

type BrandLogoProps = {
  context?: "login" | "sidebar" | "header";
  tone?: "light" | "dark";
  compact?: boolean;
  showText?: boolean;
  textClassName?: string;
  className?: string;
};

const BRAND_ASSET_VERSION = "2026-04-26";

const brandAssetByTone: Record<NonNullable<BrandLogoProps["tone"]>, string> = {
  dark: "/brand/demetra-logo-dark.png",
  light: "/brand/demetra-logo-light.png",
};

const imageClassByContext: Record<NonNullable<BrandLogoProps["context"]>, string> = {
  login: "h-12 w-auto object-contain",
  header: "h-8 w-auto object-contain",
  sidebar: "h-8 w-auto object-contain",
};

const cacheBustedSrc = (src: string) => `${src}?v=${BRAND_ASSET_VERSION}`;

export default function BrandLogo({
  context = "sidebar",
  tone = "light",
  compact = false,
  showText = true,
  textClassName = "text-current",
  className = "",
}: BrandLogoProps) {
  const shouldShowText = showText && !compact;
  const currentAsset = useMemo(() => brandAssetByTone[tone], [tone]);

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      <img
        src={cacheBustedSrc(currentAsset)}
        alt="Marca Demetra"
        className={imageClassByContext[context]}
      />
      {shouldShowText ? (
        <div className={`leading-tight ${textClassName}`.trim()}>
          <p className="text-sm font-semibold">Demetra</p>
          <p className="text-xs">Agro Performance</p>
        </div>
      ) : null}
    </div>
  );
}
