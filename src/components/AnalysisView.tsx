import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Equal,
  Info,
  ListChecks,
  Minus,
  Settings2,
  Table2,
  Target,
  TrendingDown,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  calculateRetainedSavingsSummary,
  calculateSavingsGoalProgress,
  formatCny,
  type AppSettings,
  type ForecastOutcome,
  type LedgerSummary,
  type PayCyclePlan,
  type SavingsEvent,
  type SavingsGoalProgress,
  type SpendingAnalysis,
} from "../domain";
import "./AnalysisView.css";

export interface AnalysisViewProps {
  analysis?: SpendingAnalysis;
  savingsEvents?: readonly SavingsEvent[];
  summary?: LedgerSummary;
  settings?: AppSettings;
  payCycle?: PayCyclePlan;
  entryCount?: number;
  loading?: boolean;
  error?: string;
  onOpenSettings(): void;
  onOpenIncomeForecast(): void;
  onOpenLedger(): void;
}

type Amount = number | bigint | undefined;

function displayAmount(amount: Amount): string {
  if (amount === undefined) return "—";
  try {
    return formatCny(amount);
  } catch {
    return "无法计算";
  }
}

function displaySignedAmount(amount: bigint | undefined): string {
  if (amount === undefined) return "—";
  if (amount === 0n) return formatCny(amount);
  return `${amount > 0n ? "+" : "−"}${formatCny(amount < 0n ? -amount : amount)}`;
}

function shortDate(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function readableDate(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function axisAmount(value: number): string {
  if (!Number.isFinite(value)) return "";
  const whole = Math.round(value / 100);
  return `¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(whole)}`;
}

function tooltipAmount(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "—";
  return formatCny(value);
}

function confidenceLabel(analysis: SpendingAnalysis): string {
  if (analysis.confidence === "ready") return "近 30 天";
  if (analysis.confidence === "preliminary") return "初步估算";
  return `还差 ${Math.max(0, analysis.window.daysNeeded - analysis.window.observedDays)} 天`;
}

function affordabilityLabel(value: ForecastOutcome | undefined): string {
  if (!value) return "待估算";
  if (value === "surplus") return "够花";
  if (value === "shortfall") return "还差";
  return "刚好够";
}

function StatusIcon({ value }: { value: ForecastOutcome | undefined }) {
  if (value === "surplus") return <CheckCircle2 aria-hidden="true" />;
  if (value === "shortfall") return <AlertTriangle aria-hidden="true" />;
  if (value === "exact") return <Equal aria-hidden="true" />;
  return <Info aria-hidden="true" />;
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "positive" | "negative" | "pending";
}) {
  return (
    <div className={`analysis-metric analysis-metric--${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <dd className="analysis-metric-detail">{detail}</dd> : null}
    </div>
  );
}

function ChartKey({
  kind,
  children,
}: {
  kind: "actual" | "predicted" | "expense" | "outflow";
  children: ReactNode;
}) {
  return (
    <span className="analysis-chart-key-item">
      <i className={`analysis-chart-key-line analysis-chart-key-line--${kind}`} aria-hidden="true" />
      {children}
    </span>
  );
}

interface ChartFrameProps {
  id: string;
  title: string;
  description?: string;
  keys?: ReactNode;
  children: ReactNode;
  table: ReactNode;
}

function ChartFrame({ id, title, description, keys, children, table }: ChartFrameProps) {
  return (
    <section className="analysis-chart-section" aria-labelledby={`${id}-title`}>
      <div className="analysis-chart-heading">
        <div>
          <h3 id={`${id}-title`}>{title}</h3>
          {description ? <p id={`${id}-description`}>{description}</p> : null}
        </div>
        {keys ? <div className="analysis-chart-key" aria-label={`${title}图例`}>{keys}</div> : null}
      </div>
      <div className="analysis-chart" aria-describedby={description ? `${id}-description` : undefined}>
        {children}
      </div>
      <details className="analysis-data-details">
        <summary aria-label={`${title}：查看数据表`}><Table2 aria-hidden="true" /> 数据表</summary>
        <div className="analysis-table-wrap">{table}</div>
      </details>
    </section>
  );
}

function useCompactCharts(): boolean {
  const query = "(max-width: 39.99rem)";
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  ));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return compact;
}

function ForecastEquation({
  label,
  leftLabel,
  leftValue,
  expenseValue,
  difference,
}: {
  label: string;
  leftLabel: string;
  leftValue: Amount;
  expenseValue: Amount;
  difference?: bigint;
}) {
  return (
    <div
      className="analysis-equation"
      role="group"
      aria-label={`${label}：${leftLabel} ${displayAmount(leftValue)}，减去预计支出 ${displayAmount(expenseValue)}，差额 ${displaySignedAmount(difference)}`}
    >
      <strong className="analysis-equation-label">{label}</strong>
      <div><span>{leftLabel}</span><strong>{displayAmount(leftValue)}</strong></div>
      <Minus className="analysis-equation-operator" aria-hidden="true" />
      <div><span>预计支出</span><strong>{displayAmount(expenseValue)}</strong></div>
      <Equal className="analysis-equation-operator" aria-hidden="true" />
      <div className={difference !== undefined && difference < 0n ? "is-negative" : "is-result"}>
        <span>差额</span><strong>{displaySignedAmount(difference)}</strong>
      </div>
    </div>
  );
}

function daysToCloseShortfall(difference: bigint | undefined, days: number): bigint | undefined {
  if (difference === undefined || difference >= 0n || days <= 0) return undefined;
  const shortfall = -difference;
  return (shortfall + BigInt(days) - 1n) / BigInt(days);
}

function AnalysisBasis({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <section className="analysis-basis" aria-labelledby="analysis-basis-title">
      <h3 id="analysis-basis-title">估算依据</h3>
      <details>
        <summary>
          <span>日常 {displayAmount(analysis.includedExpenseMinor)}</span>
          <span>周期 {displayAmount(analysis.periodicExpenseMinor)}</span>
          <span>一次 {displayAmount(analysis.oneTimeExpenseMinor)}</span>
          <span>待报 {displayAmount(analysis.pendingReimbursementMinor)}</span>
          <span>待确认 {analysis.pendingConfirmationCount}</span>
        </summary>
        <div className="analysis-basis-detail">
          <dl>
            <div><dt>完整日</dt><dd>{analysis.window.observedDays}</dd></div>
            <div><dt>日均</dt><dd>{displayAmount(analysis.window.averageDailyExpenseMinor)}</dd></div>
            <div><dt>零支出日</dt><dd>已计入</dd></div>
          </dl>
          {analysis.confidence !== "insufficient" ? <p>截至昨天；今天按完整一天估算。</p> : null}
        </div>
      </details>
    </section>
  );
}

function CashflowDetails({ summary }: { summary?: LedgerSummary }) {
  return (
    <details className="analysis-cashflow">
      <summary>实际现金流</summary>
      <dl>
        <div><dt>流入</dt><dd>{displayAmount(summary?.monthCashInMinor)}</dd></div>
        <div><dt>流出</dt><dd>{displayAmount(summary?.monthCashOutMinor)}</dd></div>
      </dl>
    </details>
  );
}

function SecondaryChart({ compact, label, children }: { compact: boolean; label: string; children: ReactNode }) {
  if (!compact) return children;
  return (
    <details className="analysis-chart-disclosure">
      <summary><BarChart3 aria-hidden="true" /> {label}</summary>
      {children}
    </details>
  );
}

function StatePanel({
  kind,
  title,
  message,
  actionLabel,
  onAction,
}: {
  kind: "empty" | "error" | "loading";
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const Icon = kind === "error" ? CircleAlert : kind === "loading" ? BarChart3 : CalendarClock;
  const ActionIcon = actionLabel?.includes("设置") ? Settings2 : ListChecks;
  return (
    <section className={`analysis-state analysis-state--${kind}`} role={kind === "error" ? "alert" : undefined}>
      <Icon aria-hidden="true" />
      <div>
        <h3>{title}</h3>
        <p>{message}</p>
        {actionLabel && onAction ? (
          <button type="button" className="secondary-button analysis-state-action" onClick={onAction}>
            <ActionIcon aria-hidden="true" /> {actionLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CurrentCycleTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>本期流出</caption>
      <thead><tr><th scope="col">日期</th><th scope="col">实际流出</th><th scope="col">日常预测</th></tr></thead>
      <tbody>
        {analysis.currentCycleSeries.length ? analysis.currentCycleSeries.map((point) => (
          <tr key={point.dateKey}>
            <th scope="row">{point.dateKey}</th>
            <td>{displayAmount(point.actualCumulativeMinor)}</td>
            <td>{displayAmount(point.projectedCumulativeMinor)}</td>
          </tr>
        )) : <tr><td colSpan={3}>当前周期暂无支出。</td></tr>}
      </tbody>
    </table>
  );
}

function CompletedCyclesTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>周期流出</caption>
      <thead><tr><th scope="col">周期</th><th scope="col">天数</th><th scope="col">实际流出</th></tr></thead>
      <tbody>
        {analysis.completedCycles.length ? analysis.completedCycles.map((cycle) => (
          <tr key={cycle.cycleStartDateKey}>
            <th scope="row">{cycle.cycleStartDateKey} 至 {cycle.cycleEndDateKey}</th>
            <td>{cycle.dayCount} 天</td>
            <td>{displayAmount(cycle.expenseMinor)}</td>
          </tr>
        )) : <tr><td colSpan={3}>暂无完整周期数据。</td></tr>}
      </tbody>
    </table>
  );
}

function DailyExpensesTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>每日支出</caption>
      <thead><tr><th scope="col">日期</th><th scope="col">支出</th></tr></thead>
      <tbody>
        {analysis.dailyExpenses.length ? analysis.dailyExpenses.map((day) => (
          <tr key={day.dateKey}><th scope="row">{day.dateKey}</th><td>{displayAmount(day.expenseMinor)}</td></tr>
        )) : <tr><td colSpan={2}>暂无完整日数据。</td></tr>}
      </tbody>
    </table>
  );
}

function savingsEventLabel(event: SavingsEvent): string {
  if (event.kind === "opening") return "已有存款";
  if (event.kind === "reserve") return "存入";
  if (event.kind === "release") return "取用";
  return "旧版存入";
}

function SavingsEventDetails({ events }: { events: readonly SavingsEvent[] }) {
  const active = events
    .filter((event) => !event.deletedAt)
    .slice()
    .sort((left, right) => right.localDateKey.localeCompare(left.localDateKey));
  return (
    <details className="analysis-data-details analysis-savings-details">
      <summary><Table2 aria-hidden="true" /> 存钱明细</summary>
      <div className="analysis-table-wrap">
        <table>
          <caption>存钱明细</caption>
          <thead><tr><th scope="col">日期</th><th scope="col">类型</th><th scope="col">金额</th><th scope="col">备注</th></tr></thead>
          <tbody>
            {active.length ? active.map((event) => (
              <tr key={event.id}>
                <th scope="row">{event.localDateKey}</th>
                <td>{savingsEventLabel(event)}</td>
                <td>{event.kind === "release" ? "−" : "+"}{formatCny(event.amountMinor)}</td>
                <td>{event.note || "—"}</td>
              </tr>
            )) : <tr><td colSpan={4}>暂无存钱记录。</td></tr>}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function goalProgress(
  settings: AppSettings | undefined,
  events: readonly SavingsEvent[],
  paydayDay: number | undefined,
): SavingsGoalProgress | undefined {
  if (!settings?.savingsGoal) return undefined;
  try {
    return calculateSavingsGoalProgress(
      settings.savingsGoal,
      calculateRetainedSavingsSummary(events),
      paydayDay,
    );
  } catch {
    return undefined;
  }
}

function SavingsGoalSection({
  progress,
  events,
}: {
  progress: SavingsGoalProgress;
  events: readonly SavingsEvent[];
}) {
  const status = progress.needsCorrection
    ? "待校正"
    : progress.status === "completed"
      ? "已完成"
      : progress.status === "overdue"
        ? "已到期"
        : "进行中";
  return (
    <section className="analysis-metrics-section analysis-savings-section" aria-labelledby="analysis-savings-title">
      <div className="analysis-section-heading">
        <div>
          <h3 id="analysis-savings-title"><Target aria-hidden="true" /> 存钱目标</h3>
          <p className="analysis-section-kicker">{readableDate(progress.targetDateKey)} · {status}</p>
        </div>
        <p>{displayAmount(progress.retainedMinor)} / {displayAmount(progress.targetMinor)}</p>
      </div>
      <progress
        value={Number(progress.retainedMinor > BigInt(progress.targetMinor)
          ? BigInt(progress.targetMinor)
          : progress.retainedMinor > 0n ? progress.retainedMinor : 0n)}
        max={Math.max(progress.targetMinor, 1)}
        aria-label="存钱目标进度"
        aria-valuetext={`已存 ${displayAmount(progress.retainedMinor)}，目标 ${displayAmount(progress.targetMinor)}`}
      />
      <dl className="analysis-metrics analysis-savings-metrics">
        <Metric label="还差" value={displayAmount(progress.remainingMinor)} tone={progress.remainingMinor > 0n ? "pending" : "positive"} />
        {progress.suggestedPerCycleMinor !== undefined ? (
          <Metric
            label="每期需存"
            value={displayAmount(progress.suggestedPerCycleMinor)}
            detail={`目标均摊 · 剩余 ${progress.remainingPaydayCount} 次`}
          />
        ) : null}
      </dl>
      {progress.needsCorrection ? (
        <p className="analysis-savings-warning" role="alert"><CircleAlert aria-hidden="true" /> 存钱记录待校正</p>
      ) : null}
      <SavingsEventDetails events={events} />
    </section>
  );
}

function errorMessage(error: string | undefined): string {
  const reason = error?.trim();
  return reason ? `${reason}。请刷新后重试。` : "无法读取本机账目。请刷新后重试。";
}

function LoadingSkeleton() {
  return <div className="analysis-loading" aria-label="正在计算分析" role="status"><span /><span /><span /></div>;
}

export function AnalysisView({
  analysis,
  savingsEvents = [],
  summary,
  settings,
  payCycle,
  entryCount,
  loading = false,
  error,
  onOpenSettings,
  onOpenIncomeForecast,
  onOpenLedger,
}: AnalysisViewProps) {
  const compactCharts = useCompactCharts();
  const activePlan = payCycle ?? settings?.payCycle;
  const progress = analysis?.savingsGoal
    ?? goalProgress(settings, savingsEvents, activePlan?.paydayDay);
  const activeForecast = analysis && settings?.incomeForecast?.targetPaydayDateKey === analysis.nextCycle.cycleStartDateKey
    ? settings.incomeForecast
    : undefined;
  const dailyReduction = analysis
    ? daysToCloseShortfall(
      analysis.currentCycle.balanceGoalDifferenceMinor,
      analysis.currentCycle.daysUntilPayday,
    )
    : undefined;

  return (
    <div className="analysis-view">
      <header className="analysis-header">
        <div><h2>够不够花</h2><p className="analysis-lede">看余额、收入和日常支出。</p></div>
        {analysis ? (
          <div className={`analysis-confidence analysis-confidence--${analysis.confidence}`}>
            <span>{confidenceLabel(analysis)}</span>
            <small>含 0 支出日</small>
          </div>
        ) : null}
      </header>

      {loading ? <LoadingSkeleton /> : error ? (
        <StatePanel kind="error" title="分析不可用" message={errorMessage(error)} actionLabel="返回记账" onAction={onOpenLedger} />
      ) : (
        <>
          {!activePlan ? (
            <StatePanel kind="empty" title="设置发薪日" message="设置后才能估算到账前后是否够花。" actionLabel="设置发薪日" onAction={onOpenSettings} />
          ) : !analysis ? (
            <StatePanel kind="error" title="分析不可用" message="请重新打开分析页。" actionLabel="返回记账" onAction={onOpenLedger} />
          ) : entryCount === 0 || (entryCount === undefined && analysis.window.observedDays === 0) ? (
            <StatePanel kind="empty" title="暂无支出" message="记录满 14 个完整日后开始估算。" actionLabel="去记一笔" onAction={onOpenLedger} />
          ) : (
            <>
              <section className="analysis-outlook" aria-labelledby="analysis-outlook-title">
                <div className="analysis-outlook-heading">
                  <h3 id="analysis-outlook-title">结论</h3>
                  <p className="analysis-method"><Info aria-hidden="true" /> 只算日常；不含周期、一次、待报。</p>
                </div>
                <div className="analysis-verdict-grid">
                  <article className={`analysis-verdict analysis-verdict--${analysis.currentCycle.affordability ?? "pending"}`}>
                    <div className="analysis-verdict-label"><StatusIcon value={analysis.currentCycle.affordability} /> 到下次</div>
                    <strong>{affordabilityLabel(analysis.currentCycle.affordability)}</strong>
                    <p>{analysis.currentCycle.balanceGoalDifferenceMinor === undefined
                      ? `还差 ${Math.max(0, analysis.window.daysNeeded - analysis.window.observedDays)} 个完整日。`
                      : displaySignedAmount(analysis.currentCycle.balanceGoalDifferenceMinor)}</p>
                    <small>{readableDate(analysis.currentCycle.nextPaydayDateKey)}</small>
                  </article>

                  <article className={`analysis-verdict analysis-verdict--${analysis.nextCycle.expectedIncomeScenario?.affordability ?? "pending"}`}>
                    <div className="analysis-verdict-label"><StatusIcon value={analysis.nextCycle.expectedIncomeScenario?.affordability} /> 下次收入</div>
                    {activeForecast ? (
                      <>
                        <strong>{affordabilityLabel(analysis.nextCycle.expectedIncomeScenario?.affordability)}</strong>
                        <p>{displaySignedAmount(analysis.nextCycle.expectedIncomeScenario?.differenceMinor)}</p>
                        <small>预计 {displayAmount(activeForecast.expectedIncomeMinor)} · {analysis.nextCycle.days} 天</small>
                      </>
                    ) : (
                      <button type="button" className="secondary-button analysis-income-action" onClick={onOpenIncomeForecast}>填写预计</button>
                    )}
                  </article>
                </div>
              </section>

              <section className="analysis-funds" aria-labelledby="analysis-funds-title">
                <div className="analysis-section-heading">
                  <h3 id="analysis-funds-title">资金推导</h3>
                  {dailyReduction !== undefined ? (
                    <p className="analysis-daily-reduction"><TrendingDown aria-hidden="true" /> 每天少花 {displayAmount(dailyReduction)}</p>
                  ) : null}
                </div>
                <div className="analysis-equations">
                  <ForecastEquation
                    label="到下次"
                    leftLabel="可花余额"
                    leftValue={analysis.currentCycle.spendableBalanceMinor ?? analysis.currentCycle.safeToSpendMinor}
                    expenseValue={analysis.currentCycle.estimatedRemainingExpenseMinor}
                    difference={analysis.currentCycle.balanceGoalDifferenceMinor}
                  />
                  {activeForecast ? (
                    <ForecastEquation
                      label="下次收入"
                      leftLabel="预计收入"
                      leftValue={activeForecast.expectedIncomeMinor}
                      expenseValue={analysis.nextCycle.referenceSpendMinor}
                      difference={analysis.nextCycle.expectedIncomeScenario?.differenceMinor}
                    />
                  ) : null}
                </div>
                <dl className="analysis-metrics analysis-supporting-metrics">
                  <Metric label="总余额" value={summary ? displayAmount(summary.balanceMinor) : "—"} />
                  <Metric label="已存" value={displayAmount(analysis.retainedSavings?.totalRetainedMinor ?? 0n)} />
                  <Metric label="本期流出" value={displayAmount(analysis.currentCycle.actualExpenseMinor)} />
                  <Metric label="本月收入" value={summary ? displayAmount(summary.monthIncomeMinor) : "—"} tone="positive" />
                  <Metric label="本月支出" value={summary ? displayAmount(summary.monthExpenseMinor) : "—"} tone="negative" />
                  <Metric label="近日均" value={displayAmount(analysis.window.averageDailyExpenseMinor)} detail={`${analysis.window.observedDays} 个完整日`} />
                </dl>
                <CashflowDetails summary={summary} />
              </section>

              <AnalysisBasis analysis={analysis} />

              <ChartFrame
                id="current-cycle-chart"
                title="本期流出"
                description={`已流出 ${displayAmount(analysis.currentCycle.actualExpenseMinor)}；虚线只预测日常。`}
                keys={<><ChartKey kind="actual">实际流出</ChartKey><ChartKey kind="predicted">日常预测</ChartKey></>}
                table={<CurrentCycleTable analysis={analysis} />}
              >
                {analysis.currentCycleSeries.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analysis.currentCycleSeries.map((point) => ({ ...point, dateLabel: shortDate(point.dateKey) }))} margin={{ top: 18, right: 12, left: 4, bottom: 4 }} accessibilityLayer aria-labelledby="current-cycle-chart-title" aria-describedby="current-cycle-chart-description">
                      <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} minTickGap={18} />
                      <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                      <Tooltip formatter={(value) => tooltipAmount(value)} labelFormatter={(label) => `日期 ${label}`} />
                      <Line type="monotone" dataKey="actualCumulativeMinor" name="实际流出" stroke="var(--focus)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="projectedCumulativeMinor" name="日常预测" stroke="var(--expense)" strokeWidth={2.5} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <p className="analysis-chart-empty">当前周期暂无支出。</p>}
              </ChartFrame>

              <div className="analysis-chart-grid">
                <SecondaryChart compact={compactCharts} label="周期流出">
                  <ChartFrame
                    id="completed-cycle-chart"
                    title="周期流出"
                    description={analysis.completedCycles.length ? `最近 ${analysis.completedCycles.length} 个完整周期。` : undefined}
                    keys={<ChartKey kind="outflow">实际流出</ChartKey>}
                    table={<CompletedCyclesTable analysis={analysis} />}
                  >
                    {analysis.completedCycles.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analysis.completedCycles.map((cycle) => ({ ...cycle, dateLabel: `${shortDate(cycle.cycleStartDateKey)}–${shortDate(cycle.cycleEndDateKey)}` }))} margin={{ top: 18, right: 8, left: 4, bottom: 24 }} accessibilityLayer aria-labelledby="completed-cycle-chart-title" aria-describedby="completed-cycle-chart-description">
                          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                          <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} interval="preserveStartEnd" angle={-18} textAnchor="end" height={42} />
                          <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                          <Tooltip formatter={(value) => tooltipAmount(value)} />
                          <Bar dataKey="expenseMinor" name="实际流出" fill="var(--focus)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="analysis-chart-empty">暂无完整周期数据。</p>}
                  </ChartFrame>
                </SecondaryChart>

                <SecondaryChart compact={compactCharts} label="每日支出">
                  <ChartFrame
                    id="daily-expense-chart"
                    title="每日支出"
                    description={analysis.dailyExpenses.length ? `${analysis.window.observedDays} 个完整日共 ${displayAmount(analysis.window.totalExpenseMinor)}；仅含日常。` : undefined}
                    keys={<ChartKey kind="expense">每日支出</ChartKey>}
                    table={<DailyExpensesTable analysis={analysis} />}
                  >
                    {analysis.dailyExpenses.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={analysis.dailyExpenses.map((day) => ({ ...day, dateLabel: shortDate(day.dateKey) }))} margin={{ top: 18, right: 8, left: 4, bottom: 4 }} accessibilityLayer aria-labelledby="daily-expense-chart-title" aria-describedby="daily-expense-chart-description">
                          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                          <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} minTickGap={12} />
                          <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                          <Tooltip formatter={(value) => tooltipAmount(value)} labelFormatter={(label) => `日期 ${label}`} />
                          <Bar dataKey="expenseMinor" name="每日支出" fill="var(--expense)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <p className="analysis-chart-empty">暂无完整日数据。</p>}
                  </ChartFrame>
                </SecondaryChart>
              </div>

            </>
          )}
          {progress ? <SavingsGoalSection progress={progress} events={savingsEvents} /> : settings?.savingsGoalNeedsSetup ? (
            <StatePanel kind="empty" title="重设目标" message="旧周期目标无法自动转换，请重新填写。" actionLabel="返回记账" onAction={onOpenLedger} />
          ) : null}
        </>
      )}
    </div>
  );
}
