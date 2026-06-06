import { useMemo } from "react";

type BrandLogoProps = {
  context?: "login" | "sidebar" | "header";
  tone?: "light" | "dark";
  compact?: boolean;
  showText?: boolean;
  textClassName?: string;
  brandNameClassName?: string;
  taglineClassName?: string;
  className?: string;
};

const BRAND_ASSET_VERSION = "2026-04-26";

const brandAssetByTone: Record<NonNullable<BrandLogoProps["tone"]>, string> = {
  dark: "/brand/demetra-logo-dark.png",
  light: "/brand/demetra-logo-light.png",
};

const imageClassByContext: Record<
  NonNullable<BrandLogoProps["context"]>,
  string
> = {
  login: "h-12 w-auto shrink-0 object-contain",
  header: "h-8 w-auto shrink-0 object-contain",
  sidebar: "h-8 w-auto shrink-0 object-contain",
};

const cacheBustedSrc = (src: string) => `${src}?v=${BRAND_ASSET_VERSION}`;

export default function BrandLogo({
  context = "sidebar",
  tone = "light",
  compact = false,
  showText = true,
  textClassName = "text-current",
  brandNameClassName = "font-semibold",
  taglineClassName = "",
  className = "",
}: BrandLogoProps) {
  const shouldShowText = showText && !compact;
  const currentAsset = useMemo(() => brandAssetByTone[tone], [tone]);

  return (
    <div
      className={`inline-flex min-w-0 items-center gap-3 ${className}`.trim()}
    >
      <img
        src={cacheBustedSrc(currentAsset)}
        alt="Marca Demetra"
        className={imageClassByContext[context]}
      />
      {shouldShowText ? (
        <div className={`min-w-0 leading-tight ${textClassName}`.trim()}>
          <p
            className={`truncate whitespace-nowrap text-sm ${brandNameClassName}`.trim()}
          >
            Demetra
          </p>
          <p
            className={`truncate whitespace-nowrap text-xs ${taglineClassName}`.trim()}
          >
            Agro Performance
          </p>
        </div>
      ) : null}
    </div>
  );
}
