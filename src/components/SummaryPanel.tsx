import {
  ArrowDownLeft,
  ArrowUpRight,
  CircleAlert,
  CircleCheckBig,
  PencilLine,
  Target,
  WalletCards,
} from "lucide-react";
import {
  calculateMonthEndBalanceGoalStatus,
  formatCny,
  type AppSettings,
  type LedgerSummary,
} from "../domain";

interface SummaryPanelProps {
  summary?: LedgerSummary;
  settings?: AppSettings;
  loading: boolean;
  onOpenSettings(): void;
}

export function SummaryPanel({ summary, settings, loading, onOpenSettings }: SummaryPanelProps) {
  const targetMinor = settings?.monthEndBalanceGoalMinor;
  const goalStatus = summary && targetMinor !== undefined
    ? calculateMonthEndBalanceGoalStatus(summary.balanceMinor, targetMinor)
    : undefined;

  return (
    <section className="summary-panel" aria-labelledby="summary-title" aria-busy={loading}>
      <div className="summary-topline">
        <p id="summary-title"><WalletCards aria-hidden="true" /> 当前余额</p>
        <button type="button" className="summary-edit" onClick={onOpenSettings}>
          <PencilLine aria-hidden="true" /> 余额设置
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

      {goalStatus ? (
        <div className={`balance-goal ${goalStatus.isOnTrack ? "is-on-track" : "is-behind"}`}>
          <div className="balance-goal-heading">
            <span><Target aria-hidden="true" /> 本月余额底线</span>
            <strong>{formatCny(goalStatus.targetMinor)}</strong>
          </div>
          <div className="balance-goal-status" aria-live="polite" aria-atomic="true">
            {goalStatus.isOnTrack
              ? <CircleCheckBig aria-hidden="true" />
              : <CircleAlert aria-hidden="true" />}
            <span>
              {goalStatus.differenceMinor === 0n
                ? "当前正好达到底线"
                : goalStatus.isOnTrack
                  ? `当前高出 ${formatCny(goalStatus.differenceMinor)}`
                  : `当前还差 ${formatCny(-goalStatus.differenceMinor)}`}
              <small>
                {goalStatus.daysRemaining === 0
                  ? "今天是本月最后一天"
                  : `距月末还有 ${goalStatus.daysRemaining} 天`}
              </small>
            </span>
          </div>
        </div>
      ) : settings ? (
        <button type="button" className="balance-goal-setup" onClick={onOpenSettings}>
          <Target aria-hidden="true" /> 设置月末余额底线
        </button>
      ) : null}

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
