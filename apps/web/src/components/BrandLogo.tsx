import { useEffect, useState } from "react";

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

const getThemeLogoSrc = () => {
  if (typeof document === "undefined") {
    return "/logo-demetra-dark.svg";
  }

  const isDark = document.documentElement.classList.contains("dark");

  const logoSrc = isDark
    ? "/logo-demetra-light.svg"
    : "/logo-demetra-dark.svg";

  return logoSrc;
};

export default function BrandLogo({ size = "sidebar", variant, className = "" }: BrandLogoProps) {
  const [logoSrc, setLogoSrc] = useState(() => {
    if (variant === "light") {
      return "/logo-demetra-light.svg";
    }

    if (variant === "dark") {
      return "/logo-demetra-dark.svg";
    }

    return getThemeLogoSrc();
  });

  useEffect(() => {
    if (variant === "light") {
      setLogoSrc("/logo-demetra-light.svg");
      return;
    }

    if (variant === "dark") {
      setLogoSrc("/logo-demetra-dark.svg");
      return;
    }

    const updateLogoSrc = () => {
      setLogoSrc(getThemeLogoSrc());
    };

    updateLogoSrc();

    const observer = new MutationObserver(() => {
      updateLogoSrc();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
    };
  }, [variant]);

  return (
    <img
      src={logoSrc}
      alt="Demetra Agro Performance"
      className={`${sizeClasses[size]} ${className}`.trim()}
      draggable={false}
    />
  );
}
