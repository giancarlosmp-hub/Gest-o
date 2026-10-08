import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const ANCHOR_GAP = 4;
const VIEWPORT_MARGIN = 8;

// Área (atributo data-action-menu-boundary) que o menu respeita ao decidir se abre para baixo, ex.: lista de cards de uma coluna.
const ACTION_MENU_BOUNDARY_ATTRIBUTE = "data-action-menu-boundary";

type ActionMenuPopoverProps = {
  anchorRef: RefObject<HTMLElement>;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
};

type MenuPosition = {
  top: number;
  left: number;
  maxHeight?: number;
  hidden: boolean;
};

function computeMenuPosition(anchor: HTMLElement, menu: HTMLElement, align: "start" | "end"): MenuPosition {
  const anchorRect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const boundaryRect = anchor.closest(`[${ACTION_MENU_BOUNDARY_ATTRIBUTE}]`)?.getBoundingClientRect();

  const borderHeight = menu.offsetHeight - menu.clientHeight;
  const menuHeight = menu.scrollHeight + borderHeight;
  const menuWidth = menu.offsetWidth;

  const viewportBottom = viewportHeight - VIEWPORT_MARGIN;
  const preferredBottom = Math.min(viewportBottom, (boundaryRect?.bottom ?? viewportHeight) - VIEWPORT_MARGIN);
  const spaceBelowInBoundary = preferredBottom - anchorRect.bottom - ANCHOR_GAP;
  const spaceBelow = viewportBottom - anchorRect.bottom - ANCHOR_GAP;
  const spaceAbove = anchorRect.top - ANCHOR_GAP - VIEWPORT_MARGIN;

  // Abre sempre acima ou abaixo do botão, nunca sobre ele. Perto da borda inferior da tela ou da coluna, abre para cima.
  let openAbove: boolean;
  if (menuHeight <= spaceBelowInBoundary) openAbove = false;
  else if (menuHeight <= spaceAbove) openAbove = true;
  else openAbove = spaceAbove > spaceBelow;

  const availableHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
  const renderedHeight = Math.min(menuHeight, availableHeight);
  const top = openAbove ? anchorRect.top - ANCHOR_GAP - renderedHeight : anchorRect.bottom + ANCHOR_GAP;

  const preferredLeft = align === "end" ? anchorRect.right - menuWidth : anchorRect.left;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - menuWidth);
  const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);

  // Se o botão saiu da área visível (rolagem da coluna, da tabela ou da página), o menu some junto.
  const clipTop = Math.max(0, boundaryRect?.top ?? 0);
  const clipBottom = Math.min(viewportHeight, boundaryRect?.bottom ?? viewportHeight);
  const hidden = anchorRect.bottom <= clipTop || anchorRect.top >= clipBottom || anchorRect.right <= 0 || anchorRect.left >= viewportWidth;

  return {
    top,
    left,
    maxHeight: menuHeight > availableHeight ? availableHeight : undefined,
    hidden
  };
}

export default function ActionMenuPopover({ anchorRef, align = "end", className = "", children }: ActionMenuPopoverProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      setPosition(computeMenuPosition(anchor, menu, align));
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    };
  }, [anchorRef, align]);

  // Renderizado no body com position: fixed para não ser cortado pela coluna do kanban nem pela tabela.
  return createPortal(
    <div
      ref={menuRef}
      data-opportunity-action-menu
      className={`opportunity-touch-targets fixed z-[60] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white py-1 shadow-lg ${className}`}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position && !position.hidden ? "visible" : "hidden"
      }}
    >
      {children}
    </div>,
    document.body
  );
}
