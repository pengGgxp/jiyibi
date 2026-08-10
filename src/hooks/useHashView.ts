import { useCallback, useEffect, useState } from "react";

/** The two top-level surfaces exposed by the app. */
export type AppView = "ledger" | "analysis";

const DEFAULT_VIEW: AppView = "ledger";

export function parseAppView(hash: string): AppView {
  const value = hash.replace(/^#/, "").trim().toLowerCase();
  return value === "analysis" ? "analysis" : DEFAULT_VIEW;
}

function viewHash(view: AppView): string {
  return `#${view}`;
}

/**
 * Keep the view in the URL without introducing a router dependency. Unknown
 * hashes are normalised to the ledger view, which also makes old bookmarks
 * and the bare site URL deterministic.
 */
export function useHashView(): [AppView, (view: AppView) => void] {
  const [view, setView] = useState<AppView>(() => parseAppView(window.location.hash));

  useEffect(() => {
    const currentHash = window.location.hash;
    const parsed = parseAppView(currentHash);
    setView(parsed);
    if (currentHash !== viewHash(parsed)) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${viewHash(parsed)}`);
    }

    const onHashChange = () => {
      const nextHash = window.location.hash;
      const nextView = parseAppView(nextHash);
      setView(nextView);
      if (nextHash !== viewHash(nextView)) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${viewHash(nextView)}`);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((nextView: AppView) => {
    if (nextView === parseAppView(window.location.hash)) return;
    window.location.hash = viewHash(nextView);
  }, []);

  return [view, navigate];
}
