import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type SidebarContextValue = {
  isPinnedExpanded: boolean;
  setPinnedExpanded: (value: boolean) => void;
  togglePinnedExpanded: () => void;
};

const SIDEBAR_STORAGE_KEY = "demetra.sidebar.pinnedExpanded";

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isPinnedExpanded, setPinnedExpanded] = useState(false);

  useEffect(() => {
    const savedPreference = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (savedPreference === "true") {
      setPinnedExpanded(true);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isPinnedExpanded));
  }, [isPinnedExpanded]);

  const value = useMemo(
    () => ({
      isPinnedExpanded,
      setPinnedExpanded,
      togglePinnedExpanded: () => setPinnedExpanded((currentValue) => !currentValue),
    }),
    [isPinnedExpanded]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used inside SidebarProvider");
  }

  return context;
}
