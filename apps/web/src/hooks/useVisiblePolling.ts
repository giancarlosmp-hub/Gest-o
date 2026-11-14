import { useEffect, useRef } from "react";

// Chama `tick` a cada `intervalMs` só com a aba visível; ao voltar a ficar visível, chama uma vez na hora.
// `enabled` falso para tudo. A função mais recente é sempre a usada (sem reiniciar o intervalo).
export function useVisiblePolling(tick: () => void, intervalMs: number, enabled = true) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;
    const visible = () => document.visibilityState === "visible";
    const timer = window.setInterval(() => {
      if (visible()) tickRef.current();
    }, intervalMs);
    const onVisibility = () => {
      if (visible()) tickRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
