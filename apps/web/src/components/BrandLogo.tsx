import { useState } from "react";

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

export default function BrandLogo({ size = "sidebar", textClassName = "text-current", className = "" }: BrandLogoProps) {
  const [hasError, setHasError] = useState(false);

  return (
    <div className={`inline-flex items-center gap-3 ${className}`.trim()}>
      {hasError ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-700 text-lg font-bold text-white" aria-label="Demetra">
          D
        </div>
      ) : (
        <img
          src="/logo-demetra.png"
          alt="Logo Demetra Agro Performance"
          className={`${sizeClasses[size]} w-auto object-contain`}
          onError={() => setHasError(true)}
        />
      )}
      <div className={`leading-tight ${textClassName}`.trim()}>
        <p className="text-sm font-semibold">Demetra</p>
        <p className="text-xs">Agro Performance</p>
      </div>
    </div>
  );
}
