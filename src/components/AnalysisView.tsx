import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Equal,
  Info,
  ListChecks,
  Settings2,
  Table2,
} from "lucide-react";
import type { ReactNode } from "react";
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
  formatCny,
  type AppSettings,
  type IncomeScenarioAnalysis,
  type LedgerSummary,
  type PayCyclePlan,
  type SpendingAnalysis,
} from "../domain";
import "./AnalysisView.css";

export interface AnalysisViewProps {
  analysis?: SpendingAnalysis;
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

function longDate(dateKey: string): string {
  return dateKey.replace(/-/g, "/");
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
  if (analysis.confidence === "ready") return "近 30 天估算";
  if (analysis.confidence === "preliminary") return "初步估算";
  const remaining = Math.max(0, analysis.window.daysNeeded - analysis.window.observedDays);
  return `还差 ${remaining} 个完整日`;
}

function confidenceDescription(analysis: SpendingAnalysis): string {
  const { observedDays, daysNeeded } = analysis.window;
  if (analysis.confidence === "ready") return "包含 0 支出日";
  if (analysis.confidence === "preliminary") return `已有 ${observedDays} 个完整日`;
  return `满 ${daysNeeded} 个完整日后开始估算`;
}

function affordabilityLabel(value: "surplus" | "shortfall" | "exact" | undefined): string {
  if (!value) return "暂不预测";
  if (value === "surplus") return "预计够用";
  if (value === "shortfall") return "预计有缺口";
  return "预计刚好覆盖";
}

function StatusIcon({ value }: { value: "surplus" | "shortfall" | "exact" | undefined }) {
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

function ChartKey({ kind, children }: { kind: "actual" | "predicted" | "expense"; children: ReactNode }) {
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
        <summary aria-label={`${title}：查看数据表`}><Table2 aria-hidden="true" /> 查看数据表</summary>
        <div className="analysis-table-wrap">{table}</div>
      </details>
    </section>
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
      <caption>当前周期累计支出</caption>
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col">实际累计</th>
          <th scope="col">预测累计</th>
          <th scope="col">说明</th>
        </tr>
      </thead>
      <tbody>
        {analysis.currentCycleSeries.length ? analysis.currentCycleSeries.map((point) => (
          <tr key={point.dateKey}>
            <th scope="row">{longDate(point.dateKey)}</th>
            <td>{displayAmount(point.actualCumulativeMinor)}</td>
            <td>{displayAmount(point.projectedCumulativeMinor)}</td>
            <td>{point.isPaydayBoundary ? "发薪日" : ""}</td>
          </tr>
        )) : (
          <tr><td colSpan={4}>当前周期暂无支出。</td></tr>
        )}
      </tbody>
    </table>
  );
}

function CompletedCyclesTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>完整工资周期支出</caption>
      <thead>
        <tr>
          <th scope="col">周期</th>
          <th scope="col">支出</th>
        </tr>
      </thead>
      <tbody>
        {analysis.completedCycles.length ? analysis.completedCycles.map((cycle) => (
          <tr key={`${cycle.cycleStartDateKey}-${cycle.cycleEndDateKey}`}>
            <th scope="row">{shortDate(cycle.cycleStartDateKey)}—{shortDate(cycle.cycleEndDateKey)}</th>
            <td>{displayAmount(cycle.expenseMinor)}</td>
          </tr>
        )) : (
          <tr><td colSpan={2}>暂无完整周期数据。</td></tr>
        )}
      </tbody>
    </table>
  );
}

function DailyExpensesTable({ analysis }: { analysis: SpendingAnalysis }) {
  const title = analysis.dailyExpenses.length
    ? `近 ${analysis.window.observedDays} 个完整日的每日支出`
    : "每日支出";

  return (
    <table>
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col">支出</th>
        </tr>
      </thead>
      <tbody>
        {analysis.dailyExpenses.length ? analysis.dailyExpenses.map((day) => (
          <tr key={day.dateKey}>
            <th scope="row">{longDate(day.dateKey)}</th>
            <td>{displayAmount(day.expenseMinor)}</td>
          </tr>
        )) : (
          <tr><td colSpan={2}>暂无完整日数据。</td></tr>
        )}
      </tbody>
    </table>
  );
}

function currentCycleVerdict(analysis: SpendingAnalysis): string {
  const cycle = analysis.currentCycle;
  if (cycle.projectedEndBalanceMinor === undefined || cycle.balanceGoalDifferenceMinor === undefined) {
    return `本周期已支出 ${displayAmount(cycle.actualExpenseMinor)}，数据不足，暂不预测周期末余额。`;
  }
  if (cycle.affordability === "surplus") {
    return `预计周期末余额 ${displayAmount(cycle.projectedEndBalanceMinor)}，高出周期底线 ${displayAmount(cycle.balanceGoalDifferenceMinor)}。`;
  }
  if (cycle.affordability === "shortfall") {
    return `预计周期末余额 ${displayAmount(cycle.projectedEndBalanceMinor)}，低于周期底线 ${displayAmount(-cycle.balanceGoalDifferenceMinor)}。`;
  }
  return `预计周期末余额 ${displayAmount(cycle.projectedEndBalanceMinor)}，刚好达到周期底线。`;
}

function currentCycleChartDescription(analysis: SpendingAnalysis): string {
  const cycle = analysis.currentCycle;
  if (cycle.projectedEndBalanceMinor === undefined) {
    return `本周期已支出 ${displayAmount(cycle.actualExpenseMinor)}，暂不预测周期末余额。`;
  }
  return `本周期已支出 ${displayAmount(cycle.actualExpenseMinor)}，预计周期末余额 ${displayAmount(cycle.projectedEndBalanceMinor)}。`;
}

function scenarioVerdict(scenario: IncomeScenarioAnalysis | undefined): string {
  if (!scenario) return "数据不足，暂不判断。";
  if (scenario.affordability === "surplus") {
    return `按当前花法可多 ${displayAmount(scenario.differenceMinor)}。`;
  }
  if (scenario.affordability === "shortfall") {
    return `按当前花法还差 ${displayAmount(-scenario.differenceMinor)}。`;
  }
  return "按当前花法刚好覆盖。";
}

function dailyChartDescription(analysis: SpendingAnalysis): string {
  const { observedDays, totalExpenseMinor } = analysis.window;
  return `${observedDays} 个完整日共支出 ${displayAmount(totalExpenseMinor)}，包含 0 支出日。`;
}

function errorMessage(error: string | undefined): string {
  const reason = error?.trim().replace(/[。！？!?]+$/u, "");
  if (!reason) return "无法读取本机账目。请刷新页面重试。";
  if (/存储空间不足|配额/u.test(reason)) return `${reason}。请释放本机存储空间后重试。`;
  if (/超出安全范围/u.test(reason)) return `${reason}。请检查账目后重新打开分析页。`;
  return `${reason}。请刷新页面重试。`;
}

function AnalysisHeader({ analysis }: { analysis?: SpendingAnalysis }) {
  return (
    <header className="analysis-header">
      <div>
        <h2>够不够花</h2>
        <p className="analysis-lede">按近 30 天支出，估算发薪前和下个工资周期是否够用。</p>
      </div>
      {analysis ? (
        <div className={`analysis-confidence analysis-confidence--${analysis.confidence}`}>
          <span>{confidenceLabel(analysis)}</span>
          <small>{confidenceDescription(analysis)}</small>
        </div>
      ) : null}
    </header>
  );
}

function LoadingSkeleton() {
  return (
    <div className="analysis-loading" aria-label="正在计算分析" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

export function AnalysisView({
  analysis,
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
  const activePlan = payCycle ?? settings?.payCycle;
  const activeForecast = analysis && settings?.incomeForecast?.targetPaydayDateKey === analysis.nextCycle.cycleStartDateKey
    ? settings.incomeForecast
    : undefined;

  return (
    <div className="analysis-view">
      <AnalysisHeader analysis={analysis} />

      {loading ? <LoadingSkeleton /> : error ? (
        <StatePanel
          kind="error"
          title="分析暂时不可用"
          message={errorMessage(error)}
          actionLabel="返回记账页"
          onAction={onOpenLedger}
        />
      ) : !activePlan ? (
        <StatePanel
          kind="empty"
          title="先设置发薪周期"
          message="需要发薪日和周期底线。"
          actionLabel="设置发薪周期"
          onAction={onOpenSettings}
        />
      ) : !analysis ? (
        <StatePanel
          kind="error"
          title="分析暂时不可用"
          message="没有生成分析结果。请重新打开分析页重试。"
          actionLabel="返回记账页"
          onAction={onOpenLedger}
        />
      ) : entryCount === 0 || (entryCount === undefined && analysis.window.observedDays === 0) ? (
        <StatePanel
          kind="empty"
          title="还没有支出记录"
          message="记录满 14 个完整日后开始估算。"
          actionLabel="去记一笔"
          onAction={onOpenLedger}
        />
      ) : (
        <>
          <section className="analysis-outlook" aria-labelledby="analysis-outlook-title">
            <div className="analysis-outlook-heading">
              <h3 id="analysis-outlook-title">结论</h3>
              <p className="analysis-method"><Info aria-hidden="true" /> 只统计已记录支出，不含固定支出。</p>
            </div>
            <div className="analysis-verdict-grid">
              <article className={`analysis-verdict analysis-verdict--${analysis.currentCycle.affordability ?? "pending"}`}>
                <div className="analysis-verdict-label"><StatusIcon value={analysis.currentCycle.affordability} /> 到发薪日</div>
                <strong>{affordabilityLabel(analysis.currentCycle.affordability)}</strong>
                <p>{currentCycleVerdict(analysis)}</p>
                <small>剩余 {analysis.currentCycle.daysUntilPayday} 天 · 每日可花 {displayAmount(analysis.currentCycle.dailySafeToSpendMinor)}</small>
              </article>
              <article className={`analysis-verdict analysis-verdict--${analysis.nextCycle.expectedIncomeScenario?.affordability ?? "pending"}`}>
                <div className="analysis-verdict-label"><StatusIcon value={analysis.nextCycle.expectedIncomeScenario?.affordability} /> 下个工资周期</div>
                <small className="analysis-income-basis">按近 {analysis.window.observedDays} 个完整日的花法 · 周期 {analysis.nextCycle.days} 天</small>
                {activeForecast ? (
                  <div className="analysis-income-scenarios">
                    <div>
                      <span><StatusIcon value={analysis.nextCycle.minimumIncomeScenario?.affordability} /> 最低收入 {displayAmount(activeForecast.minimumIncomeMinor)}</span>
                      <strong>{affordabilityLabel(analysis.nextCycle.minimumIncomeScenario?.affordability)}</strong>
                      <p>{scenarioVerdict(analysis.nextCycle.minimumIncomeScenario)}</p>
                    </div>
                    <div>
                      <span><StatusIcon value={analysis.nextCycle.expectedIncomeScenario?.affordability} /> 预计收入 {displayAmount(activeForecast.expectedIncomeMinor)}</span>
                      <strong>{affordabilityLabel(analysis.nextCycle.expectedIncomeScenario?.affordability)}</strong>
                      <p>{scenarioVerdict(analysis.nextCycle.expectedIncomeScenario)}</p>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="secondary-button analysis-income-action" onClick={onOpenIncomeForecast}>
                    填写下次收入
                  </button>
                )}
              </article>
            </div>
          </section>

          <section className="analysis-metrics-section" aria-labelledby="analysis-metrics-title">
            <div className="analysis-section-heading">
              <h3 id="analysis-metrics-title">关键数据</h3>
            </div>
            <dl className="analysis-metrics">
              <Metric
                label="预计周期末余额"
                value={displayAmount(analysis.currentCycle.projectedEndBalanceMinor)}
                detail="本周期结束时"
                tone={analysis.currentCycle.affordability === "shortfall" ? "negative" : analysis.currentCycle.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric
                label="距周期底线"
                value={displaySignedAmount(analysis.currentCycle.balanceGoalDifferenceMinor)}
                detail={`周期底线 ${displayAmount(activePlan.cycleEndBalanceGoalMinor)}`}
                tone={analysis.currentCycle.affordability === "shortfall" ? "negative" : analysis.currentCycle.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric
                label="最低收入差额"
                value={displaySignedAmount(analysis.nextCycle.minimumIncomeScenario?.differenceMinor)}
                detail="最低收入与当前花法"
                tone={analysis.nextCycle.minimumIncomeScenario?.affordability === "shortfall" ? "negative" : analysis.nextCycle.minimumIncomeScenario?.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric
                label="预计收入差额"
                value={displaySignedAmount(analysis.nextCycle.expectedIncomeScenario?.differenceMinor)}
                detail="预计收入与当前花法"
                tone={analysis.nextCycle.expectedIncomeScenario?.affordability === "shortfall" ? "negative" : analysis.nextCycle.expectedIncomeScenario?.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric label="近 30 天日均支出" value={displayAmount(analysis.window.averageDailyExpenseMinor)} detail={`近 ${analysis.window.observedDays} 个完整日`} />
              <Metric label="本周期支出" value={displayAmount(analysis.currentCycle.actualExpenseMinor)} detail="从发薪日开始" />
              <Metric label="本月收入" value={summary ? `+${displayAmount(summary.monthIncomeMinor)}` : "—"} detail="有效收入记录" tone="positive" />
              <Metric label="本月支出" value={summary ? `−${displayAmount(summary.monthExpenseMinor)}` : "—"} detail="有效支出记录" tone="negative" />
            </dl>
          </section>

          {analysis.confidence !== "insufficient" ? (
            <section className="analysis-insight-strip" aria-label="统计口径">
              <ListChecks aria-hidden="true" />
              <p>统计口径：截至昨天的 {analysis.window.observedDays} 个完整日，包含 0 支出日；今天按完整一天估算。</p>
            </section>
          ) : null}

          <ChartFrame
            id="current-cycle-chart"
            title="当前周期累计支出"
            description={currentCycleChartDescription(analysis)}
            keys={<><ChartKey kind="actual">实际支出</ChartKey><ChartKey kind="predicted">预测支出</ChartKey></>}
            table={<CurrentCycleTable analysis={analysis} />}
          >
            {analysis.currentCycleSeries.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={analysis.currentCycleSeries.map((point) => ({ ...point, dateLabel: shortDate(point.dateKey) }))}
                  margin={{ top: 18, right: 12, left: 4, bottom: 4 }}
                  accessibilityLayer
                  aria-labelledby="current-cycle-chart-title"
                  aria-describedby="current-cycle-chart-description"
                >
                  <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} minTickGap={18} />
                  <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                  <Tooltip formatter={(value) => tooltipAmount(value)} labelFormatter={(label) => `日期 ${label}`} />
                  <Line type="monotone" dataKey="actualCumulativeMinor" name="实际支出" stroke="var(--focus)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="projectedCumulativeMinor" name="预测支出" stroke="var(--expense)" strokeWidth={2.5} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <p className="analysis-chart-empty">当前周期暂无支出。</p>}
          </ChartFrame>

          <div className="analysis-chart-grid">
            <ChartFrame
              id="completed-cycle-chart"
              title="完整工资周期支出"
              description={analysis.completedCycles.length ? `显示最近 ${analysis.completedCycles.length} 个完整周期。` : undefined}
              keys={<ChartKey kind="expense">实际支出</ChartKey>}
              table={<CompletedCyclesTable analysis={analysis} />}
            >
              {analysis.completedCycles.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analysis.completedCycles.map((cycle) => ({ ...cycle, dateLabel: `${shortDate(cycle.cycleStartDateKey)}—${shortDate(cycle.cycleEndDateKey)}` }))}
                    margin={{ top: 18, right: 8, left: 4, bottom: 24 }}
                    accessibilityLayer
                    aria-labelledby="completed-cycle-chart-title"
                    aria-describedby="completed-cycle-chart-description"
                  >
                    <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} interval="preserveStartEnd" angle={-18} textAnchor="end" height={42} />
                    <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(value) => tooltipAmount(value)} />
                    <Bar dataKey="expenseMinor" name="实际支出" fill="var(--focus)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="analysis-chart-empty">暂无完整周期数据。</p>}
            </ChartFrame>

            <ChartFrame
              id="daily-expense-chart"
              title={analysis.dailyExpenses.length ? `近 ${analysis.window.observedDays} 个完整日的每日支出` : "每日支出"}
              description={analysis.dailyExpenses.length ? dailyChartDescription(analysis) : undefined}
              keys={<ChartKey kind="expense">每日支出</ChartKey>}
              table={<DailyExpensesTable analysis={analysis} />}
            >
              {analysis.dailyExpenses.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analysis.dailyExpenses.map((day) => ({ ...day, dateLabel: shortDate(day.dateKey) }))}
                    margin={{ top: 18, right: 8, left: 4, bottom: 4 }}
                    accessibilityLayer
                    aria-labelledby="daily-expense-chart-title"
                    aria-describedby="daily-expense-chart-description"
                  >
                    <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="dateLabel" tickLine={false} axisLine={false} minTickGap={12} />
                    <YAxis tickFormatter={axisAmount} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(value) => tooltipAmount(value)} labelFormatter={(label) => `日期 ${label}`} />
                    <Bar dataKey="expenseMinor" name="每日支出" fill="var(--expense)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="analysis-chart-empty">暂无完整日数据。</p>}
            </ChartFrame>
          </div>
        </>
      )}
    </div>
  );
}
