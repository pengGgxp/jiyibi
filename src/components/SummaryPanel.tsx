import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  CircleCheckBig,
  Equal,
  Gauge,
  Minus,
  PencilLine,
  PiggyBank,
  Plus,
  Target,
  WalletCards,
} from "lucide-react";
import {
  formatCny,
  type AppSettings,
  type ForecastOutcome,
  type IncomeScenarioAnalysis,
  type LedgerSummary,
  type PayCyclePlan,
  type RetainedSavingsSummary,
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
  onOpenSettings(): void;
  onOpenIncomeForecast(): void;
  onOpenAnalysis(): void;
  onReserveSavings(): void;
  onReleaseSavings(): void;
  canSettleSavings: boolean;
  onSettleSavings(): void;
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

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function currentCycleCopy(analysis: SpendingAnalysis): { title: string; detail: string } {
  const { currentCycle, confidence, window } = analysis;
  if (confidence === "insufficient" || currentCycle.affordability === undefined) {
    const remainingDays = Math.max(0, window.daysNeeded - window.observedDays);
    return {
      title: "暂不判断",
      detail: remainingDays > 0
        ? `还需数据覆盖 ${remainingDays} 个完整日`
        : "历史记录还不足",
    };
  }
  if (currentCycle.affordability === "exact") {
    return { title: "预计刚好达到", detail: "按近期已记录花法估算，刚好完成留存目标" };
  }
  const difference = currentCycle.balanceGoalDifferenceMinor ?? 0n;
  return currentCycle.affordability === "surplus"
    ? { title: "预计够用", detail: `完成留存目标后还可剩 ${formatCny(difference)}` }
    : { title: "预计有缺口", detail: `完成留存目标还差 ${formatCny(amountMagnitude(difference))}` };
}

function scenarioCopy(scenario: IncomeScenarioAnalysis | undefined, analysis: SpendingAnalysis) {
  if (!scenario) {
    const remainingDays = Math.max(0, analysis.window.daysNeeded - analysis.window.observedDays);
    return {
      title: "暂不判断",
      detail: remainingDays > 0 ? `还需数据覆盖 ${remainingDays} 个完整日` : "历史记录还不足",
    };
  }
  if (scenario.affordability === "exact") {
    return { title: "刚好覆盖", detail: "与近期已记录花法相当" };
  }
  return scenario.affordability === "surplus"
    ? { title: "预计够用", detail: `按近期已记录花法可多 ${formatCny(scenario.differenceMinor)}` }
    : { title: "预计有缺口", detail: `按近期已记录花法还差 ${formatCny(amountMagnitude(scenario.differenceMinor))}` };
}

function confidenceLabel(analysis: SpendingAnalysis): string {
  if (analysis.confidence === "ready") return "按近 30 天已记录花法估算";
  if (analysis.confidence === "preliminary") {
    return `初步估算 · 数据覆盖 ${analysis.window.observedDays} 天`;
  }
  return "数据覆盖不足";
}

function readableDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return month && day ? `${Number(month)} 月 ${Number(day)} 日` : dateKey;
}

export function SummaryPanel({
  summary,
  settings,
  payCycle,
  analysis,
  retainedSavings,
  analysisError,
  loading,
  onOpenSettings,
  onOpenIncomeForecast,
  onOpenAnalysis,
  onReserveSavings,
  onReleaseSavings,
  canSettleSavings,
  onSettleSavings,
}: SummaryPanelProps) {
  const currentCopy = analysis ? currentCycleCopy(analysis) : undefined;
  const activeForecast = analysis && settings?.incomeForecast?.targetPaydayDateKey === analysis.nextCycle.cycleStartDateKey
    ? settings.incomeForecast
    : undefined;
  const minimumCopy = analysis ? scenarioCopy(analysis.nextCycle.minimumIncomeScenario, analysis) : undefined;
  const expectedCopy = analysis ? scenarioCopy(analysis.nextCycle.expectedIncomeScenario, analysis) : undefined;
  const rawSpendableMinor = analysis?.currentCycle.spendableBalanceMinor
    ?? (summary && retainedSavings
      ? BigInt(summary.balanceMinor) - retainedSavings.totalRetainedMinor
      : undefined);
  const retainedMinor = analysis?.currentCycle.retainedBalanceMinor
    ?? retainedSavings?.totalRetainedMinor;
  const remainingTargetMinor = analysis?.currentCycle.remainingSavingsTargetMinor;
  const cycleNetGrowthMinor = analysis?.currentCycle.cycleNetGrowthMinor;
  const savingsTargetMinor = analysis?.currentCycle.savingsTargetMinor;
  const displayBalance = rawSpendableMinor === undefined
    ? BigInt(summary?.balanceMinor ?? 0)
    : nonNegative(rawSpendableMinor);
  const savingsWarning = analysis?.currentCycle.savingsNeedsCorrection || retainedSavings?.needsCorrection
    ? "留存记录待校正"
    : rawSpendableMinor !== undefined && rawSpendableMinor < 0n
      ? BigInt(summary?.balanceMinor ?? 0) < (retainedMinor ?? 0n)
        ? "当前总余额已低于已留存金额，实际动用了留存。"
        : "当前资金不足以同时覆盖留存和本周期目标。"
      : undefined;

  return (
    <section className="summary-panel" aria-labelledby="summary-title" aria-busy={loading}>
      <div className="summary-topline">
        <p id="summary-title"><WalletCards aria-hidden="true" /> 可花余额</p>
        <button type="button" className="summary-edit" onClick={onOpenSettings}>
          <PencilLine aria-hidden="true" /> 余额设置
        </button>
      </div>

      {summary ? (
        <p className="balance-value">{formatCny(displayBalance)}</p>
      ) : (
        <span className="summary-skeleton balance-skeleton" aria-hidden="true" />
      )}

      {summary ? (
        <>
          <dl className="summary-savings-grid">
            <div><dt>总余额</dt><dd>{formatCny(summary.balanceMinor)}</dd></div>
            <div><dt>已留存</dt><dd>{formatCny(retainedMinor ?? 0n)}</dd></div>
            {analysis ? (
              <>
                <div><dt>本周期目标</dt><dd>{formatCny(savingsTargetMinor ?? 0)}</dd></div>
                <div><dt>净增长</dt><dd>{formatCny(cycleNetGrowthMinor ?? 0n)}</dd></div>
                <div><dt>尚需留存</dt><dd>{formatCny(remainingTargetMinor ?? 0n)}</dd></div>
              </>
            ) : null}
          </dl>
          {savingsWarning ? (
            <p className="summary-savings-warning" role="status">
              <CircleAlert aria-hidden="true" /> {savingsWarning}
            </p>
          ) : null}
          <div className="summary-savings-actions" aria-label="留存操作">
            <button type="button" className="secondary-button" onClick={onReserveSavings}>
              <Plus aria-hidden="true" /> 留存一笔
            </button>
            <button type="button" className="text-button" onClick={onReleaseSavings}>
              <Minus aria-hidden="true" /> 取用留存
            </button>
            {canSettleSavings && !settings?.incomeForecast ? (
              <button type="button" className="text-button" onClick={onSettleSavings}>
                <CircleCheckBig aria-hidden="true" /> 结算上个周期
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {!settings ? null : !payCycle ? (
        <div className="summary-plan-empty">
          <Target aria-hidden="true" />
          <div>
            <strong>先设置发薪周期</strong>
            <p>需要发薪日和每周期默认留存目标，收入每个周期单独填写。</p>
          </div>
          <button type="button" className="summary-plan-action" onClick={onOpenSettings}>
            设置发薪周期 <ArrowRight aria-hidden="true" />
          </button>
        </div>
      ) : analysisError ? (
        <div className="summary-analysis-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span><strong>分析暂时不可用</strong><small>{analysisError.message}</small></span>
        </div>
      ) : analysis && currentCopy && minimumCopy && expectedCopy ? (
        <>
          <div className="summary-confidence">{confidenceLabel(analysis)}</div>
          <div className="summary-forecast-list" aria-live="polite" aria-atomic="true">
            <div className={`summary-forecast summary-forecast--${analysis.currentCycle.affordability ?? "pending"}`}>
              <OutcomeIcon outcome={analysis.currentCycle.affordability} />
              <span><small>到发薪日</small><strong>{currentCopy.title}</strong></span>
              <p>{currentCopy.detail}</p>
            </div>
            <div className="summary-forecast summary-forecast--income">
              <PiggyBank aria-hidden="true" />
              <span><small>下个工资周期</small><strong>{analysis.nextCycle.days} 天</strong></span>
              {activeForecast ? (
                <div className="summary-income-scenarios">
                  <div className={`summary-income-scenario summary-forecast--${analysis.nextCycle.minimumIncomeScenario?.affordability ?? "pending"}`}>
                    <OutcomeIcon outcome={analysis.nextCycle.minimumIncomeScenario?.affordability} />
                    <span><small>最低收入 {formatCny(activeForecast.minimumIncomeMinor)}</small><strong>{minimumCopy.title}</strong></span>
                    <p>{minimumCopy.detail}</p>
                  </div>
                  <div className={`summary-income-scenario summary-forecast--${analysis.nextCycle.expectedIncomeScenario?.affordability ?? "pending"}`}>
                    <OutcomeIcon outcome={analysis.nextCycle.expectedIncomeScenario?.affordability} />
                    <span><small>预计收入 {formatCny(activeForecast.expectedIncomeMinor)}</small><strong>{expectedCopy.title}</strong></span>
                    <p>{expectedCopy.detail}</p>
                  </div>
                </div>
              ) : (
                <div className="summary-income-empty">
                  <p>{readableDate(analysis.nextCycle.cycleStartDateKey)}收入预期</p>
                  <button type="button" className="summary-income-action" onClick={onOpenIncomeForecast}>
                    填写下次收入 <ArrowRight aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <dl className="summary-allowance">
            <div>
              <dt><CalendarClock aria-hidden="true" /> 剩余天数</dt>
              <dd>{analysis.currentCycle.daysUntilPayday === 0
                ? "今天"
                : `${analysis.currentCycle.daysUntilPayday} 天`}</dd>
            </div>
            <div>
              <dt><Gauge aria-hidden="true" /> 每日可花</dt>
              <dd>{formatCny(analysis.currentCycle.dailySafeToSpendMinor)}</dd>
            </div>
          </dl>
          <a className="summary-analysis-link" href="#analysis" onClick={onOpenAnalysis}>
            查看详细分析 <ArrowRight aria-hidden="true" />
          </a>
        </>
      ) : loading ? (
        <div className="summary-forecast-skeleton" aria-hidden="true"><span /><span /></div>
      ) : null}
    </section>
  );
}
