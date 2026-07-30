import { ArrowDownLeft, ArrowUpRight, PencilLine, WalletCards } from "lucide-react";
import { formatCny, type AppSettings, type LedgerSummary } from "../domain";

interface SummaryPanelProps {
  summary?: LedgerSummary;
  settings?: AppSettings;
  loading: boolean;
  onOpenSettings(): void;
}

export function SummaryPanel({ summary, settings, loading, onOpenSettings }: SummaryPanelProps) {
  return (
    <section className="summary-panel" aria-labelledby="summary-title" aria-busy={loading}>
      <div className="summary-topline">
        <p id="summary-title"><WalletCards aria-hidden="true" /> 当前余额</p>
        <button type="button" className="summary-edit" onClick={onOpenSettings}>
          <PencilLine aria-hidden="true" /> 调整初始余额
        </button>
      </div>

      {summary ? (
        <p className="balance-value">{formatCny(summary.balanceMinor)}</p>
      ) : (
        <span className="summary-skeleton balance-skeleton" aria-hidden="true" />
      )}
      <p className="initial-balance">
        初始余额 {settings ? formatCny(settings.initialBalanceMinor) : "读取中"}
      </p>

      <div className="month-summary" aria-label="本月收支">
        <div>
          <span className="summary-icon income"><ArrowDownLeft aria-hidden="true" /></span>
          <span>
            <small>本月收入</small>
            <strong>{summary ? `+${formatCny(summary.monthIncomeMinor)}` : "—"}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon expense"><ArrowUpRight aria-hidden="true" /></span>
          <span>
            <small>本月支出</small>
            <strong>{summary ? `−${formatCny(summary.monthExpenseMinor)}` : "—"}</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
