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
  TrendingDown,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatCny,
  type AppSettings,
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

function confidenceLabel(confidence: SpendingAnalysis["confidence"]): string {
  if (confidence === "ready") return "按近 30 天估算";
  if (confidence === "preliminary") return "初步估算";
  return "数据积累中";
}

function confidenceDescription(analysis: SpendingAnalysis): string {
  const { observedDays, daysNeeded } = analysis.window;
  if (analysis.confidence === "ready") {
    return "统计最近 30 个已完成本地日期；没有支出的日期也计入日均。";
  }
  if (analysis.confidence === "preliminary") {
    return `已记录 ${observedDays} 个完整日，先用现有记录做初步估算。`;
  }
  const remaining = Math.max(0, daysNeeded - observedDays);
  return remaining > 0
    ? `还需积累 ${remaining} 个完整日，暂不下“够不够花”的结论。`
    : "当前记录还不足以形成稳定估算。";
}

function affordabilityLabel(value: "surplus" | "shortfall" | "exact" | undefined, next = false): string {
  if (!value) return "积累中";
  if (value === "surplus") return next ? "工资预计够用" : "预计够用";
  if (value === "shortfall") return next ? "工资预计不够" : "预计有缺口";
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

function ChartKey({ kind, children }: { kind: "actual" | "predicted" | "salary" | "expense"; children: ReactNode }) {
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
  description: string;
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
          <p id={`${id}-description`}>{description}</p>
        </div>
        {keys ? <div className="analysis-chart-key" aria-label="图例">{keys}</div> : null}
      </div>
      <div className="analysis-chart" aria-describedby={`${id}-description`}>
        {children}
      </div>
      <details className="analysis-data-details">
        <summary><Table2 aria-hidden="true" /> 查看数据表</summary>
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
      <caption>当前工资周期每日累计支出</caption>
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
          <tr><td colSpan={4}>当前周期还没有支出记录</td></tr>
        )}
      </tbody>
    </table>
  );
}

function CompletedCyclesTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>最近六个完整工资周期支出</caption>
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
          <tr><td colSpan={2}>还没有完整工资周期</td></tr>
        )}
      </tbody>
    </table>
  );
}

function DailyExpensesTable({ analysis }: { analysis: SpendingAnalysis }) {
  return (
    <table>
      <caption>最近三十个完成日期每日支出</caption>
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
          <tr><td colSpan={2}>还没有可统计的完成日期</td></tr>
        )}
      </tbody>
    </table>
  );
}

function currentCycleInsight(analysis: SpendingAnalysis): string {
  const cycle = analysis.currentCycle;
  if (cycle.projectedEndBalanceMinor === undefined || cycle.balanceGoalDifferenceMinor === undefined) {
    return `当前周期已记录支出 ${displayAmount(cycle.actualExpenseMinor)}；数据不足，暂不预测周期末余额。`;
  }
  if (cycle.affordability === "surplus") {
    return `按已记录账目估算，周期末余额为 ${displayAmount(cycle.projectedEndBalanceMinor)}，预计高出底线 ${displayAmount(cycle.balanceGoalDifferenceMinor)}。`;
  }
  if (cycle.affordability === "shortfall") {
    return `按已记录账目估算，周期末余额为 ${displayAmount(cycle.projectedEndBalanceMinor)}，预计低于底线 ${displayAmount(-cycle.balanceGoalDifferenceMinor)}。`;
  }
  return `按已记录账目估算，周期末余额预计刚好达到 ${displayAmount(cycle.projectedEndBalanceMinor)}。`;
}

function nextCycleInsight(analysis: SpendingAnalysis): string {
  const cycle = analysis.nextCycle;
  if (cycle.estimatedExpenseMinor === undefined || cycle.salaryDifferenceMinor === undefined) {
    return "先积累足够的历史支出数据，再估算下个工资周期。";
  }
  if (cycle.affordability === "surplus") {
    return `下个周期约 ${cycle.days} 天，预计支出 ${displayAmount(cycle.estimatedExpenseMinor)}，工资预计有 ${displayAmount(cycle.salaryDifferenceMinor)} 结余。`;
  }
  if (cycle.affordability === "shortfall") {
    return `下个周期约 ${cycle.days} 天，预计支出 ${displayAmount(cycle.estimatedExpenseMinor)}，工资预计少 ${displayAmount(-cycle.salaryDifferenceMinor)}。`;
  }
  return `下个周期约 ${cycle.days} 天，预计支出与工资刚好相当。`;
}

function dailyInsight(analysis: SpendingAnalysis): string {
  const { observedDays, totalExpenseMinor } = analysis.window;
  return `最近 ${observedDays} 个完整日共支出 ${displayAmount(totalExpenseMinor)}；没有支出的日期也计入统计。`;
}

function AnalysisHeader({ analysis }: { analysis?: SpendingAnalysis }) {
  return (
    <header className="analysis-header">
      <div>
        <p className="eyebrow">资金判断</p>
        <h2>够不够花</h2>
        <p className="analysis-lede">用已经记录的花费速度，看看这次发薪前和下个周期的余量。</p>
      </div>
      {analysis ? (
        <div className={`analysis-confidence analysis-confidence--${analysis.confidence}`}>
          <span>{confidenceLabel(analysis.confidence)}</span>
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
  onOpenLedger,
}: AnalysisViewProps) {
  const activePlan = payCycle ?? settings?.payCycle;

  return (
    <div className="analysis-view">
      <AnalysisHeader analysis={analysis} />

      {loading ? <LoadingSkeleton /> : error ? (
        <StatePanel
          kind="error"
          title="分析暂时不可用"
          message={error || "无法读取本机账目，请稍后重试。"}
          actionLabel="回到账目"
          onAction={onOpenLedger}
        />
      ) : !activePlan ? (
        <StatePanel
          kind="empty"
          title="先设置工资周期"
          message="填写发薪日、每月工资和周期末余额底线后，这里才能判断是否够用。"
          actionLabel="去设置工资周期"
          onAction={onOpenSettings}
        />
      ) : !analysis ? (
        <StatePanel
          kind="error"
          title="分析暂时不可用"
          message="本机账目已经读取，但分析结果没有生成。请回到账目后重试。"
          actionLabel="回到账目"
          onAction={onOpenLedger}
        />
      ) : entryCount === 0 || (entryCount === undefined && analysis.window.observedDays === 0) ? (
        <StatePanel
          kind="empty"
          title="还没有可参考的花费"
          message="先记录几笔消费，积累至少 14 个完整日后，这里会开始给出“够不够花”的估算。"
          actionLabel="去记一笔"
          onAction={onOpenLedger}
        />
      ) : (
        <>
          <section className="analysis-outlook" aria-labelledby="analysis-outlook-title">
            <div className="analysis-outlook-heading">
              <div>
                <p className="eyebrow">先看结论</p>
                <h3 id="analysis-outlook-title">两段钱，分别回答</h3>
              </div>
              <p className="analysis-method"><Info aria-hidden="true" /> 仅按已记录支出估算，不预测固定支出</p>
            </div>
            <div className="analysis-verdict-grid">
              <article className={`analysis-verdict analysis-verdict--${analysis.currentCycle.affordability ?? "pending"}`}>
                <div className="analysis-verdict-label"><StatusIcon value={analysis.currentCycle.affordability} /> 到发薪日</div>
                <strong>{affordabilityLabel(analysis.currentCycle.affordability)}</strong>
                <p>{currentCycleInsight(analysis)}</p>
                <small>还剩 {analysis.currentCycle.daysUntilPayday} 天 · 每日可花 {displayAmount(analysis.currentCycle.dailySafeToSpendMinor)}</small>
              </article>
              <article className={`analysis-verdict analysis-verdict--${analysis.nextCycle.affordability ?? "pending"}`}>
                <div className="analysis-verdict-label"><StatusIcon value={analysis.nextCycle.affordability} /> 下个工资周期</div>
                <strong>{affordabilityLabel(analysis.nextCycle.affordability, true)}</strong>
                <p>{nextCycleInsight(analysis)}</p>
                <small>工资基线 {displayAmount(activePlan.monthlySalaryMinor)} · 周期约 {analysis.nextCycle.days} 天</small>
              </article>
            </div>
          </section>

          <section className="analysis-metrics-section" aria-labelledby="analysis-metrics-title">
            <div className="analysis-section-heading">
              <div>
                <p className="eyebrow">关键数字</p>
                <h3 id="analysis-metrics-title">把依据摆在一起</h3>
              </div>
              <p>{confidenceDescription(analysis)}</p>
            </div>
            <dl className="analysis-metrics">
              <Metric
                label="预计周期末余额"
                value={displayAmount(analysis.currentCycle.projectedEndBalanceMinor)}
                detail="当前周期结束时"
                tone={analysis.currentCycle.affordability === "shortfall" ? "negative" : analysis.currentCycle.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric
                label="与周期底线"
                value={displaySignedAmount(analysis.currentCycle.balanceGoalDifferenceMinor)}
                detail={`底线 ${displayAmount(activePlan.cycleEndBalanceGoalMinor)}`}
                tone={analysis.currentCycle.affordability === "shortfall" ? "negative" : analysis.currentCycle.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric
                label="下周期工资差额"
                value={displaySignedAmount(analysis.nextCycle.salaryDifferenceMinor)}
                detail="工资减去预计支出"
                tone={analysis.nextCycle.affordability === "shortfall" ? "negative" : analysis.nextCycle.affordability === "surplus" ? "positive" : "pending"}
              />
              <Metric label="近 30 天日均支出" value={displayAmount(analysis.window.averageDailyExpenseMinor)} detail="完整日期平均" />
              <Metric label="本周期已支出" value={displayAmount(analysis.currentCycle.actualExpenseMinor)} detail="从发薪日开始" />
              <Metric label="本月收入" value={summary ? `+${displayAmount(summary.monthIncomeMinor)}` : "—"} detail="有效收入记录" tone="positive" />
              <Metric label="本月支出" value={summary ? `−${displayAmount(summary.monthExpenseMinor)}` : "—"} detail="有效支出记录" tone="negative" />
            </dl>
          </section>

          <section className="analysis-insight-strip" aria-label="统计说明">
            <ListChecks aria-hidden="true" />
            <p><strong>怎么算：</strong>{dailyInsight(analysis)} 今天按一个完整消费日计入，结果是保守估算。</p>
          </section>

          <ChartFrame
            id="current-cycle-chart"
            title="当前周期，花费走到哪里了"
            description={currentCycleInsight(analysis)}
            keys={<><ChartKey kind="actual">实际累计支出（实线）</ChartKey><ChartKey kind="predicted">预测累计支出（虚线）</ChartKey><ChartKey kind="salary">当前工资参考</ChartKey></>}
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
                  <Legend />
                  <ReferenceLine
                    y={activePlan.monthlySalaryMinor}
                    stroke="var(--brand)"
                    strokeDasharray="2 4"
                    ifOverflow="extendDomain"
                    label={{ value: "当前工资参考", position: "insideTopRight", fill: "var(--brand)" }}
                  />
                  <Line type="monotone" dataKey="actualCumulativeMinor" name="实际累计支出（实线）" stroke="var(--focus)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="projectedCumulativeMinor" name="预测累计支出（虚线）" stroke="var(--expense)" strokeWidth={2.5} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <p className="analysis-chart-empty">当前周期还没有可绘制的支出点。</p>}
          </ChartFrame>

          <div className="analysis-chart-grid">
            <ChartFrame
              id="completed-cycle-chart"
              title="最近六个工资周期"
              description={analysis.completedCycles.length ? `最近 ${analysis.completedCycles.length} 个完整周期的实际支出；横线是当前工资参考。` : "还没有完整工资周期可比较。"}
              keys={<><ChartKey kind="expense">实际周期支出</ChartKey><ChartKey kind="salary">当前工资参考</ChartKey></>}
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
                    <ReferenceLine y={activePlan.monthlySalaryMinor} stroke="var(--brand)" strokeDasharray="2 4" ifOverflow="extendDomain" label={{ value: "当前工资参考", position: "insideTopRight", fill: "var(--brand)" }} />
                    <Bar dataKey="expenseMinor" name="实际周期支出" fill="var(--focus)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="analysis-chart-empty">再经过一个完整工资周期，这里会出现比较。</p>}
            </ChartFrame>

            <ChartFrame
              id="daily-expense-chart"
              title="近三十天，每天花多少"
              description={dailyInsight(analysis)}
              keys={<ChartKey kind="expense">每日支出（含零支出日）</ChartKey>}
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
              ) : <p className="analysis-chart-empty">还没有可绘制的完成日期。</p>}
            </ChartFrame>
          </div>

          <div className="analysis-footnote">
            <TrendingDown aria-hidden="true" />
            <p>预测只回答“按现在的花法大概怎样”，不会自动记入工资，也不会替你判断固定支出。</p>
            <a href="#ledger" onClick={onOpenLedger}>回到账目</a>
          </div>
        </>
      )}
    </div>
  );
}
