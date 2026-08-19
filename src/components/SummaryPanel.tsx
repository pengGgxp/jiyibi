import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  CircleCheckBig,
  Equal,
  Minus,
  PencilLine,
  PiggyBank,
  Plus,
  Target,
  WalletCards,
} from "lucide-react";
import {
  calculateSavingsGoalProgress,
  calculateSpendableBalanceMinor,
  formatCny,
  type AppSettings,
  type ForecastOutcome,
  type IncomeScenarioAnalysis,
  type LedgerSummary,
  type PayCyclePlan,
  type RetainedSavingsSummary,
  type SavingsGoalProgress,
  type SpendingAnalysis,
} from "../domain";

interface SummaryPanelProps {
  summary?: LedgerSummary;
  settings?: AppSettings;
  payCycle?: PayCyclePlan;
  analysis?: SpendingAnalysis;
  retainedSavings?: RetainedSavingsSummary;
  analysisError?: Error;
  loading: boolean;
  hasLedgerFacts: boolean;
  onOpenSettings(): void;
  onOpenBalance(): void;
  onOpenIncomeForecast(): void;
  onOpenSavingsGoal(): void;
  onOpenAnalysis(): void;
  onReserveSavings(): void;
  onReleaseSavings(): void;
}

function OutcomeIcon({ outcome }: { outcome?: ForecastOutcome }) {
  if (outcome === "surplus") return <CircleCheckBig aria-hidden="true" />;
  if (outcome === "shortfall") return <CircleAlert aria-hidden="true" />;
  if (outcome === "exact") return <Equal aria-hidden="true" />;
  return <CalendarClock aria-hidden="true" />;
}

function amountMagnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function signedAmount(value: bigint): string {
  if (value === 0n) return formatCny(value);
  return `${value > 0n ? "+" : "−"}${formatCny(amountMagnitude(value))}`;
}

function readableDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return month && day ? `${Number(month)}月${Number(day)}日` : dateKey;
}

function compactDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : dateKey;
}

function outcomeCopy(
  outcome: ForecastOutcome | undefined,
  difference: bigint | undefined,
  analysis: SpendingAnalysis,
): { label: string; amount: string } {
  if (!outcome || difference === undefined || analysis.confidence === "insufficient") {
    const remaining = Math.max(0, analysis.window.daysNeeded - analysis.window.observedDays);
    return { label: "待估算", amount: remaining > 0 ? `差 ${remaining} 天` : "数据不足" };
  }
  if (outcome === "exact") return { label: "刚好够", amount: formatCny(0) };
  if (outcome === "surplus") return { label: "够花", amount: signedAmount(difference) };
  return { label: "还差", amount: signedAmount(difference) };
}

function scenarioCopy(
  scenario: IncomeScenarioAnalysis | undefined,
  analysis: SpendingAnalysis,
): { label: string; amount: string } {
  return outcomeCopy(scenario?.affordability, scenario?.differenceMinor, analysis);
}

function goalProgress(
  settings: AppSettings | undefined,
  retained: RetainedSavingsSummary | undefined,
  paydayDay: number | undefined,
): SavingsGoalProgress | undefined {
  if (!settings?.savingsGoal || !retained) return undefined;
  try {
    return calculateSavingsGoalProgress(settings.savingsGoal, retained, paydayDay);
  } catch {
    return undefined;
  }
}

function goalStatusLabel(progress: SavingsGoalProgress): string {
  if (progress.needsCorrection) return "待校正";
  if (progress.status === "completed") return "已完成";
  if (progress.status === "overdue") return "已到期";
  return "进行中";
}

export function SummaryPanel({
  summary,
  settings,
  payCycle,
  analysis,
  retainedSavings,
  analysisError,
  loading,
  hasLedgerFacts,
  onOpenSettings,
  onOpenBalance,
  onOpenIncomeForecast,
  onOpenSavingsGoal,
  onOpenAnalysis,
  onReserveSavings,
  onReleaseSavings,
}: SummaryPanelProps) {
  const retainedMinor = retainedSavings?.totalRetainedMinor ?? 0n;
  const rawSpendableMinor = summary
    ? calculateSpendableBalanceMinor(summary.balanceMinor, retainedMinor)
    : undefined;
  const displayBalance = rawSpendableMinor;
  const progress = analysis?.savingsGoal
    ?? goalProgress(settings, retainedSavings, payCycle?.paydayDay);
  const currentCopy = analysis
    ? outcomeCopy(
      analysis.currentCycle.affordability,
      analysis.currentCycle.balanceGoalDifferenceMinor,
      analysis,
    )
    : undefined;
  const activeForecast = analysis && settings?.incomeForecast?.targetPaydayDateKey === analysis.nextCycle.cycleStartDateKey
    ? settings.incomeForecast
    : undefined;
  const expectedCopy = analysis
    ? scenarioCopy(analysis.nextCycle.expectedIncomeScenario, analysis)
    : undefined;

  if (!loading && summary && !hasLedgerFacts) {
    return (
      <section className="summary-panel summary-panel--first-use" aria-labelledby="summary-title">
        <div className="summary-topline"><p id="summary-title"><WalletCards aria-hidden="true" /> 当前余额</p></div>
        <p className="balance-value">{formatCny(summary.balanceMinor)}</p>
        <button type="button" className="summary-first-use-action" onClick={onOpenBalance}>
          <PencilLine aria-hidden="true" /> 设置余额
        </button>
      </section>
    );
  }

  return (
    <section className="summary-panel" aria-labelledby="summary-title" aria-busy={loading}>
      <div className="summary-topline">
        <p id="summary-title"><WalletCards aria-hidden="true" /> 可花余额</p>
        <button type="button" className="summary-edit" onClick={onOpenBalance}>
          <PencilLine aria-hidden="true" /> 余额设置
        </button>
      </div>

      {summary ? (
        <p className="balance-value">{formatCny(displayBalance ?? 0n)}</p>
      ) : (
        <span className="summary-skeleton balance-skeleton" aria-hidden="true" />
      )}

      {summary ? (
        <>
          <dl className="summary-savings-grid summary-balance-grid">
            <div><dt>总余额</dt><dd>{formatCny(summary.balanceMinor)}</dd></div>
            <div><dt>已存</dt><dd>{formatCny(retainedMinor)}</dd></div>
          </dl>

          {settings?.savingsGoalNeedsSetup && !settings.savingsGoal ? (
            <button type="button" className="summary-savings-warning" onClick={onOpenSavingsGoal}>
              <CircleAlert aria-hidden="true" /> 请重设目标
            </button>
          ) : null}

          {progress ? (
            <section className="summary-goal" aria-labelledby="summary-goal-title">
              <div className="summary-goal-heading">
                <span id="summary-goal-title"><Target aria-hidden="true" /> 存钱目标</span>
                <strong>{goalStatusLabel(progress)}</strong>
              </div>
              <progress
                value={Number(progress.retainedMinor > BigInt(progress.targetMinor)
                  ? BigInt(progress.targetMinor)
                  : progress.retainedMinor > 0n ? progress.retainedMinor : 0n)}
                max={Math.max(progress.targetMinor, 1)}
                aria-label="存钱目标进度"
                aria-valuetext={`已存 ${formatCny(progress.retainedMinor)}，目标 ${formatCny(progress.targetMinor)}`}
              />
              <div className="summary-goal-meta">
                <strong>{formatCny(progress.retainedMinor)} / {formatCny(progress.targetMinor)}</strong>
                <span>{readableDate(progress.targetDateKey)}</span>
              </div>
              {progress.status !== "completed" ? (
                <p>{progress.status === "overdue" ? "还差" : "剩余"} {formatCny(progress.remainingMinor)}</p>
              ) : null}
            </section>
          ) : (
            <button type="button" className="summary-goal-empty" onClick={onOpenSavingsGoal}>
              <Target aria-hidden="true" /> 设置目标 <ArrowRight aria-hidden="true" />
            </button>
          )}

          {retainedSavings?.needsCorrection || rawSpendableMinor !== undefined && rawSpendableMinor < 0n ? (
            <p className="summary-savings-warning" role="status">
              <CircleAlert aria-hidden="true" /> {retainedSavings?.needsCorrection
                ? "存款待校正"
                : retainedMinor > 0n
                  ? <>动用存款 {formatCny(-(rawSpendableMinor ?? 0n))}</>
                  : <>余额不足 {formatCny(-(rawSpendableMinor ?? 0n))}</>}
            </p>
          ) : null}

          <div className="summary-savings-actions" role="group" aria-label="存钱操作">
            {rawSpendableMinor !== undefined && rawSpendableMinor > 0n ? <button type="button" className="secondary-button" onClick={onReserveSavings}>
              <Plus aria-hidden="true" /> 存一笔
            </button> : null}
            {retainedMinor > 0n ? <button type="button" className="text-button" onClick={onReleaseSavings}>
              <Minus aria-hidden="true" /> 取用
            </button> : null}
            {progress ? (
              <button type="button" className="text-button" onClick={onOpenSavingsGoal}>
                <PencilLine aria-hidden="true" /> 修改
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {!settings ? null : !payCycle ? (
        <div className="summary-plan-empty">
          <Target aria-hidden="true" />
          <div><strong>设置发薪日</strong><p>用于估算到账前后是否够花。</p></div>
          <button type="button" className="summary-plan-action" onClick={onOpenSettings}>
            去设置 <ArrowRight aria-hidden="true" />
          </button>
        </div>
      ) : analysisError ? (
        <div className="summary-analysis-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span><strong>分析不可用</strong><small>{analysisError.message}</small></span>
        </div>
      ) : analysis && currentCopy && expectedCopy ? (
        <>
          <div className="summary-forecast-list" aria-live="polite" aria-atomic="true">
            <div className={`summary-forecast summary-forecast--${analysis.currentCycle.affordability ?? "pending"}`}>
              <OutcomeIcon outcome={analysis.currentCycle.affordability} />
              <span><small>到 {compactDate(analysis.currentCycle.nextPaydayDateKey)}</small><strong>{currentCopy.label}</strong></span>
              <p>{currentCopy.amount}</p>
            </div>
            <div className={`summary-forecast summary-forecast--${analysis.nextCycle.expectedIncomeScenario?.affordability ?? "pending"}`}>
              <PiggyBank aria-hidden="true" />
              <span><small>下次收入</small><strong>{activeForecast ? formatCny(activeForecast.expectedIncomeMinor) : "未填写"}</strong></span>
              {activeForecast ? (
                <p><span>{expectedCopy.label}</span> {expectedCopy.amount}</p>
              ) : (
                <button type="button" className="summary-income-action" onClick={onOpenIncomeForecast}>
                  填写 <ArrowRight aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <p className="summary-forecast-basis">按已记花法</p>
          <a className="summary-analysis-link" href="#analysis" onClick={onOpenAnalysis}>
            详细分析 <ArrowRight aria-hidden="true" />
          </a>
        </>
      ) : loading ? (
        <div className="summary-forecast-skeleton" aria-hidden="true"><span /><span /></div>
      ) : null}
    </section>
  );
}
