import BrandLogo from "../BrandLogo";

type SidebarBrandProps = {
  expanded: boolean;
  className?: string;
};

export default function SidebarBrand({
  expanded,
  className = "",
}: SidebarBrandProps) {
  return (
    <div
      className={`flex h-11 min-w-0 items-center overflow-hidden ${className}`.trim()}
    >
      <div className={expanded ? "min-w-0 max-w-full" : "hidden"}>
        <BrandLogo
          context="sidebar"
          tone="light"
          showText
          className="min-w-0 max-w-full"
        />
      </div>
      <div className={expanded ? "hidden" : "flex w-full justify-center"}>
        <BrandLogo context="sidebar" tone="light" compact />
      </div>
    </div>
  );
}
