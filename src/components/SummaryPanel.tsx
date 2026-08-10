import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CircleAlert,
  CircleCheckBig,
  Coins,
  PencilLine,
  Target,
  WalletCards,
} from "lucide-react";
import {
  formatCny,
  type AppSettings,
  type LedgerSummary,
  type PayCycleStatus,
} from "../domain";

interface SummaryPanelProps {
  summary?: LedgerSummary;
  settings?: AppSettings;
  payCycleStatus?: PayCycleStatus;
  loading: boolean;
  onOpenSettings(): void;
}

function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}月${day}日`;
}

export function SummaryPanel({ summary, settings, payCycleStatus, loading, onOpenSettings }: SummaryPanelProps) {
  const legacyGoal = settings?.monthEndBalanceGoalMinor;

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

      {payCycleStatus ? (
        <div className={`balance-goal pay-cycle-card ${payCycleStatus.isCurrentlyAtOrAboveGoal ? "is-on-track" : "is-behind"}`}>
          <div className="balance-goal-heading">
            <span><CalendarDays aria-hidden="true" /> 工资周期</span>
            <strong>每月 {payCycleStatus.paydayDay} 日发薪</strong>
          </div>
          <div className="pay-cycle-range">
            <span>{shortDate(payCycleStatus.cycleStartDateKey)}—{shortDate(payCycleStatus.cycleEndDateKey)}</span>
            <span>下次发薪 {shortDate(payCycleStatus.nextPaydayDateKey)}</span>
          </div>
          <div className="salary-budget">
            <div className="salary-budget-heading">
              <span><Coins aria-hidden="true" /> 每月工资</span>
              <strong>{formatCny(payCycleStatus.monthlySalaryMinor)}</strong>
            </div>
            <div
              className="salary-progress"
              role="progressbar"
              aria-label="本周期工资支出比例"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, payCycleStatus.salarySpentPercent)}
            >
              <span style={{ width: `${Math.min(100, payCycleStatus.salarySpentPercent)}%` }} />
            </div>
            <p>
              已支出 {formatCny(payCycleStatus.cycleExpenseMinor)}
              {payCycleStatus.salarySpentPercent >= 999
                ? "，已超过工资"
                : `，占工资 ${payCycleStatus.salarySpentPercent}%`}
            </p>
          </div>
          <div className="balance-goal-status" aria-live="polite" aria-atomic="true">
            {payCycleStatus.isCurrentlyAtOrAboveGoal
              ? <CircleCheckBig aria-hidden="true" />
              : <CircleAlert aria-hidden="true" />}
            <span>
              {payCycleStatus.balanceHeadroomMinor === 0n
                ? "当前正好达到周期底线"
                : payCycleStatus.isCurrentlyAtOrAboveGoal
                  ? `当前余额高出 ${formatCny(payCycleStatus.balanceHeadroomMinor)}`
                  : `当前余额还差 ${formatCny(-payCycleStatus.balanceHeadroomMinor)}`}
              <small>
                周期末底线 {formatCny(payCycleStatus.targetMinor)} ·
                {payCycleStatus.daysUntilPayday === 1
                  ? "明天发薪"
                  : `距下次发薪还有 ${payCycleStatus.daysUntilPayday} 天`}
                · 当前可再花 {formatCny(payCycleStatus.safeToSpendMinor)}
              </small>
            </span>
          </div>
        </div>
      ) : settings ? (
        <div className="balance-goal-setup-wrap">
          {legacyGoal !== undefined ? (
            <p className="legacy-goal-note"><Target aria-hidden="true" /> 旧版自然月底线 {formatCny(legacyGoal)}，设置发薪日和工资后继续使用。</p>
          ) : null}
          <button type="button" className="balance-goal-setup" onClick={onOpenSettings}>
            <Target aria-hidden="true" /> 设置工资周期
          </button>
        </div>
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
