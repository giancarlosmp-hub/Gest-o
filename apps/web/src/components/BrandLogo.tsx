import { useEffect, useMemo, useState } from "react";

type BrandLogoProps = {
  context?: "login" | "sidebar" | "header";
  tone?: "light" | "dark";
  compact?: boolean;
  showText?: boolean;
  textClassName?: string;
  className?: string;
};

const BRAND_ASSET_VERSION = "2026-04-26";

const brandAssetCandidatesByTone: Record<NonNullable<BrandLogoProps["tone"]>, string[]> = {
  dark: ["/brand/demetra-logo-dark.png", "/brand/demetra-logo-dark.svg"],
  light: ["/brand/demetra-logo-light.png", "/brand/demetra-logo-light.svg"],
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
  const [assetIndex, setAssetIndex] = useState(0);

  const assetCandidates = useMemo(() => brandAssetCandidatesByTone[tone], [tone]);
  const currentAsset = assetCandidates[assetIndex];

  useEffect(() => {
    setAssetIndex(0);
  }, [tone]);

  const handleError = () => {
    const nextIndex = assetIndex + 1;

    if (nextIndex < assetCandidates.length) {
      setAssetIndex(nextIndex);
    }
  };

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      {currentAsset ? (
        <img
          src={cacheBustedSrc(currentAsset)}
          alt="Marca Demetra"
          className={imageClassByContext[context]}
          onError={handleError}
        />
      ) : (
        <span
          aria-hidden
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/15 text-xs font-bold text-current"
        >
          DA
        </span>
      )}
      {shouldShowText ? (
        <div className={`leading-tight ${textClassName}`.trim()}>
          <p className="text-sm font-semibold">Demetra</p>
          <p className="text-xs">Agro Performance</p>
        </div>
      ) : null}
    </div>
  );
}
