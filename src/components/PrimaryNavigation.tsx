import { BarChart3, BookOpen } from "lucide-react";
import type { AppView } from "../hooks/useHashView";

interface PrimaryNavigationProps {
  view: AppView;
}

/** Accessible top-level navigation for the ledger and analysis surfaces. */
export function PrimaryNavigation({ view }: PrimaryNavigationProps) {
  return (
    <nav className="primary-navigation" aria-label="主要页面">
      <a
        className={`primary-navigation-link${view === "ledger" ? " is-active" : ""}`}
        href="#ledger"
        aria-current={view === "ledger" ? "page" : undefined}
      >
        <BookOpen aria-hidden="true" />
        <span>记账</span>
      </a>
      <a
        className={`primary-navigation-link${view === "analysis" ? " is-active" : ""}`}
        href="#analysis"
        aria-current={view === "analysis" ? "page" : undefined}
      >
        <BarChart3 aria-hidden="true" />
        <span>分析</span>
      </a>
    </nav>
  );
}
