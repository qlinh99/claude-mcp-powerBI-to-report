// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profileDataset } from "./datasetProfiler.js";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

// mode: what kind of analysis this report performs
// "month-extremes" – highest/lowest revenue month (existing behaviour)
// "ranking"        – top/bottom N by any dimension
// "trend"          – metric over ordered time axis (not asking for extremes)
// "distribution"   – breakdown by one or more dimensions
// "generic"        – fallback when intent is unclear

type ReportMode = "month-extremes" | "ranking" | "trend" | "distribution" | "generic";

interface ReportIntent {
  mode: ReportMode;
  primaryMetric?: string;    // detected numeric column
  primaryDimension?: string; // detected label/axis column
  topN: number;              // for ranking
  language: "vi" | "en";
}

// ═══════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════

export async function buildDashboardResponse(request) {
  const generatedAt = new Date().toISOString();
  const table = normalizeDaxResult(request.result);
  const datasets = normalizeReportDatasets(request, table);
  const datasetProfiles = datasets.map(dataset => profileDataset(dataset));
  const multiDatasetMode = datasetProfiles.length > 1;
  const intent = detectReportIntent(request.question, table.rows, table.columns);

  // Month-extremes needs the existing deep analysis object
  const monthlyRows = !multiDatasetMode && intent.mode === "month-extremes"
    ? selectMonthlyRows(table.rows)
    : table.rows;
  const analysis = !multiDatasetMode && intent.mode === "month-extremes"
    ? analyzeRevenueMonthExtremes(request.question, monthlyRows, table.columns)
    : undefined;

  const business = multiDatasetMode ? undefined : buildBusinessInsightModel(intent, analysis, table.rows, table.columns);
  const insights = multiDatasetMode
    ? buildDatasetAwareInsights(datasetProfiles)
    : buildInsights(intent, analysis, table.rows, table.columns, business);
  const summary  = multiDatasetMode
    ? buildDatasetAwareSummary(datasetProfiles, request.joinPlan)
    : buildSummary(intent, table.rows, table.columns, analysis);
  const html     = renderDashboardHtml({
    ...request,
    rows: table.rows,
    columns: table.columns,
    datasets,
    datasetProfiles,
    summary,
    insights,
    business,
    analysis,
    intent,
    generatedAt
  });

  const dashboardPath = await writeDashboardFile(request.title || request.question, html);
  return {
    summary,
    insights,
    dashboardPath,
    dashboardUri: `file://${dashboardPath}`,
    html,
    insightCards: business?.insightCards ?? insights,
    dataProfile: business?.dataProfile ?? {
      rowCount: table.rows.length,
      columnCount: table.columns.length,
      datasetCount: datasetProfiles.length,
      datasetProfiles
    },
    nextQuestions: business?.nextQuestions ?? buildDatasetAwareNextQuestions(datasetProfiles),
    dataSources: request.dataSources ?? [],
    joinPlan: request.joinPlan,
    validationWarnings: request.validationWarnings ?? [],
    datasets,
    datasetProfiles,
    rows: table.rows,
    columns: table.columns,
    generatedAt
  };
}

function normalizeReportDatasets(request, fallbackTable) {
  if (Array.isArray(request.datasets) && request.datasets.length) {
    return request.datasets.map((dataset, index) => {
      const normalized = normalizeDaxResult({ data: dataset.rows ?? [] });
      return {
        id: dataset.id || `dataset-${index + 1}`,
        label: dataset.label || dataset.semanticModelName || dataset.evidenceRole || `Dataset ${index + 1}`,
        workspaceName: dataset.workspaceName,
        semanticModelName: dataset.semanticModelName,
        evidenceRole: dataset.evidenceRole,
        evidence: dataset.evidence ?? [],
        rows: normalized.rows,
        columns: normalized.columns
      };
    });
  }

  const groupKeyColumns = ["DataSource", "SemanticModelName"].filter(column => fallbackTable.columns.includes(column));
  if (groupKeyColumns.length && fallbackTable.rows.length) {
    const groups = new Map();
    for (const row of fallbackTable.rows) {
      const key = groupKeyColumns.map(column => String(row[column] ?? "")).filter(Boolean).join(" / ") || "Combined";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    if (groups.size > 1) {
      return [...groups.entries()].map(([key, rows], index) => ({
        id: `dataset-${index + 1}`,
        label: key,
        workspaceName: rows[0]?.WorkspaceName,
        semanticModelName: rows[0]?.SemanticModelName,
        evidenceRole: rows[0]?.EvidenceRole,
        evidence: [],
        rows,
        columns: unique(rows.flatMap(row => Object.keys(row)))
      }));
    }
  }

  return [{
    id: "primary",
    label: request.semanticModelName || "Primary dataset",
    workspaceName: request.workspaceName,
    semanticModelName: request.semanticModelName,
    evidenceRole: "primary",
    evidence: [],
    rows: fallbackTable.rows,
    columns: fallbackTable.columns
  }];
}

function buildDatasetAwareSummary(profiles, joinPlan) {
  const nonEmpty = profiles.filter(profile => profile.rowCount > 0);
  if (!nonEmpty.length) return "No rows returned from the selected semantic models.";
  const sourceText = nonEmpty
    .map(profile => `${profile.label}: ${formatNumber(profile.rowCount)} rows, ${profile.shape}, grain ${profile.grain}`)
    .join("; ");
  const joinText = joinPlan?.confidence && joinPlan.confidence !== "single-source"
    ? ` Cross-source confidence is ${joinPlan.confidence}; grain: ${joinPlan.grain ?? "source-specific evidence"}.`
    : "";
  return `Report uses ${formatNumber(nonEmpty.length)} separate evidence sources instead of forcing them into one chart. ${sourceText}.${joinText}`;
}

function buildDatasetAwareInsights(profiles) {
  return profiles.slice(0, 6).map(profile => ({
    title: `${profile.label}: ${profile.shape.replace(/_/g, " ")}`,
    detail: [
      `Grain: ${profile.grain}.`,
      profile.primaryMetric ? `Primary metric: ${profile.primaryMetric}.` : "No numeric metric detected.",
      profile.primaryDimension ? `Primary dimension: ${profile.primaryDimension}.` : "No strong dimension detected.",
      `Recommended blocks: ${profile.recommendedBlocks.join(", ")}.`
    ].join(" ")
  }));
}

function buildDatasetAwareNextQuestions(profiles) {
  const questions = [];
  const timeProfiles = profiles.filter(profile => profile.timeDimensions?.length && profile.primaryMetric);
  const pocketProfiles = profiles.filter(profile => profile.categoricalDimensions?.length >= 2 && profile.primaryMetric);
  if (timeProfiles.length) {
    questions.push(`Which time periods diverge across ${timeProfiles.map(profile => profile.label).join(" and ")} after aligning to a common grain?`);
  }
  if (pocketProfiles.length) {
    questions.push(`Which ${pocketProfiles[0].categoricalDimensions.slice(0, 2).join(" x ")} pockets explain the largest business movement?`);
  }
  if (profiles.length > 1) {
    questions.push("Which shared join keys should be returned next so the report can move from directional comparison to root-cause evidence?");
  }
  questions.push("Which missing driver fields should be added next: plan, margin, inventory, discount, campaign, dealer, or conversion?");
  return unique(questions).slice(0, 5);
}

// ═══════════════════════════════════════════════════════
// Intent detection
// ═══════════════════════════════════════════════════════

function detectReportIntent(question, rows, columns): ReportIntent {
  const lang = prefersVietnamese(question) ? "vi" : "en";
  if (!rows.length || !columns.length) {
    return { mode: "generic", topN: 10, language: lang };
  }

  const q = normalizeForMatch(question);
  const monthCol   = findMonthColumn(rows, columns);
  const revenueCol = findRevenueColumn(rows, columns);
  const numericCols = columns.filter(c => rows.some(r => typeof r[c] === "number"));
  const dimCols = columns.filter(
    c => !["Scope","Dimension","Member","DataSource","EvidenceRole","WorkspaceName","SemanticModelName"].includes(c) &&
         rows.some(r => typeof r[c] === "string")
  );
  const nonMonthDimCols = dimCols.filter(c => !isMonthLikeColumn(c, rows));

  const primaryMetric    = revenueCol ?? numericCols[0];
  const primaryDimension = monthCol   ?? dimCols[0];

  // top N from question e.g. "top 5", "5 đại lý"
  const topNMatch = question.match(/top\s*(\d+)/i)
    ?? question.match(/(\d+)\s*(đại lý|sản phẩm|khách hàng|khu vực|chi nhánh|mặt hàng|dealer|product|customer|region|branch)/i);
  const topN = topNMatch ? Math.min(parseInt(topNMatch[1]), 50) : 10;

  const monthGroupCount = monthCol ? groupByColumn(rows, monthCol).size : 0;
  const rankingSignal   = asksRankingIntent(q) || !!topNMatch;
  const asksMonth       = asksForMonthExtremes(question)
    || /\b(thang|month|monthly|theo thang|hang thang)\b/.test(q);

  // ── 1. Month extremes: has month col + ≥2 months + not a pure ranking ask ──
  if (monthCol && monthGroupCount >= 2 && (asksMonth || revenueCol) && !rankingSignal) {
    return { mode: "month-extremes", primaryMetric, primaryDimension: monthCol, topN, language: lang };
  }

  // ── 2. Ranking: explicit top-N ask, or dimension present without month signal ──
  if (rankingSignal || (nonMonthDimCols.length > 0 && numericCols.length > 0 && !monthGroupCount)) {
    const rankDim = nonMonthDimCols[0] ?? dimCols[0] ?? primaryDimension;
    return { mode: "ranking", primaryMetric, primaryDimension: rankDim, topN, language: lang };
  }

  // ── 3. Trend: has time axis but question doesn't ask for extremes ──
  if (monthCol && monthGroupCount >= 2) {
    return { mode: "trend", primaryMetric, primaryDimension: monthCol, topN, language: lang };
  }

  // ── 4. Distribution: multiple dimensions + at least one metric ──
  if (nonMonthDimCols.length >= 1 && numericCols.length >= 1) {
    return { mode: "distribution", primaryMetric, primaryDimension: nonMonthDimCols[0], topN, language: lang };
  }

  // ── 5. Generic fallback ──
  return { mode: "generic", primaryMetric, primaryDimension: dimCols[0], topN, language: lang };
}

function asksRankingIntent(q: string): boolean {
  return /\b(top|rank|xep hang|best|worst|nhieu nhat|it nhat|cao nhat|thap nhat|leading|bottom|hang dau)\b/.test(q)
    || /\b(dai ly|san pham|khach hang|khu vuc|kenh|chi nhanh|channel|product|dealer|customer|region|branch)\b/.test(q);
}

function isMonthLikeColumn(col: string, rows: any[]): boolean {
  const n = normalizeForMatch(col);
  if (["yearmonth","month","period","thang","date","ngay"].some(t => n.includes(t))) return true;
  return rows.some(r => {
    const v = r[col];
    return typeof v === "string" && looksLikeMonthValue(v);
  });
}

function groupByColumn(rows: any[], col: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = String(row[col] ?? "").trim();
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// ═══════════════════════════════════════════════════════
// Summary (mode-aware)
// ═══════════════════════════════════════════════════════

function buildSummary(intent: ReportIntent, rows: any[], columns: string[], analysis: any): string {
  if (!rows.length) return "No rows returned.";
  const vi = intent.language === "vi";

  if (intent.mode === "month-extremes" && analysis) {
    const driverText = [
      ...analysis.highest.reasons.slice(0, 1),
      ...analysis.lowest.reasons.slice(0, 1)
    ].join(" ");
    if (vi) {
      return `Tháng có ${analysis.metric} cao nhất là ${analysis.highest.label} (${formatNumber(analysis.highest.value)}); thấp nhất là ${analysis.lowest.label} (${formatNumber(analysis.lowest.value)}), chênh lệch ${formatNumber(analysis.spread)}. ${driverText}`;
    }
    return `Highest ${analysis.metric} is ${analysis.highest.label} (${formatNumber(analysis.highest.value)}); lowest is ${analysis.lowest.label} (${formatNumber(analysis.lowest.value)}), spread ${formatNumber(analysis.spread)}. ${driverText}`;
  }

  const metric = intent.primaryMetric;
  const dim    = intent.primaryDimension;
  if (!metric || !rows.length) return `Returned ${rows.length} rows.`;

  const total  = rows.reduce((s, r) => s + numericValue(r[metric]), 0);
  const sorted = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const top    = sorted[0];
  const topVal = top ? numericValue(top[metric]) : 0;
  const topLabel = top && dim ? String(top[dim] ?? "") : "";
  const share  = total ? (topVal / total * 100).toFixed(1) : "0";

  if (intent.mode === "ranking") {
    return vi
      ? `${topLabel} dẫn đầu về ${metric} với ${formatMetricValue(metric, topVal)} (${share}% tổng). Tổng ${metric}: ${formatMetricValue(metric, total)} từ ${rows.length} ${dim ?? "mục"}.`
      : `${topLabel} leads ${metric} with ${formatMetricValue(metric, topVal)} (${share}% of total). Total ${metric}: ${formatMetricValue(metric, total)} across ${rows.length} ${dim ?? "entries"}.`;
  }

  if (intent.mode === "trend" && dim) {
    const s2 = [...rows].sort((a, b) => compareDimension(a[dim], b[dim]));
    const first = s2[0], last = s2[s2.length - 1];
    const fVal = first ? numericValue(first[metric]) : 0;
    const lVal = last  ? numericValue(last[metric])  : 0;
    const delta = lVal - fVal;
    const pct = fVal ? Math.abs(delta / fVal * 100).toFixed(1) : "0";
    const dir = delta >= 0 ? (vi ? "tăng" : "up") : (vi ? "giảm" : "down");
    return vi
      ? `${metric} từ ${formatMetricValue(metric, fVal)} (${String(first?.[dim] ?? "")}) đến ${formatMetricValue(metric, lVal)} (${String(last?.[dim] ?? "")}), ${dir} ${pct}%.`
      : `${metric} from ${formatMetricValue(metric, fVal)} (${String(first?.[dim] ?? "")}) to ${formatMetricValue(metric, lVal)} (${String(last?.[dim] ?? "")}), ${dir} ${pct}%.`;
  }

  if (intent.mode === "distribution") {
    return vi
      ? `${topLabel} dẫn đầu ${dim ?? ""} với ${formatMetricValue(metric, topVal)} (${share}% tổng ${metric}: ${formatMetricValue(metric, total)}).`
      : `${topLabel} leads ${dim ?? ""} with ${formatMetricValue(metric, topVal)} (${share}% of total ${metric}: ${formatMetricValue(metric, total)}).`;
  }

  return vi
    ? `${metric} tổng ${formatMetricValue(metric, total)} từ ${rows.length} dòng. Dẫn đầu: ${topLabel} (${formatMetricValue(metric, topVal)}).`
    : `${metric} totals ${formatMetricValue(metric, total)} across ${rows.length} rows. Leader: ${topLabel} (${formatMetricValue(metric, topVal)}).`;
}

// ═══════════════════════════════════════════════════════
// Insights (mode-aware)
// ═══════════════════════════════════════════════════════

function buildInsights(intent: ReportIntent, analysis: any, rows: any[], columns: string[], business?: any) {
  const vi = intent.language === "vi";
  if (business?.insightCards?.length) {
    return business.insightCards.slice(0, 4).map(card => ({
      title: card.what,
      detail: [card.why, card.soWhat, card.action].filter(Boolean).join(" ")
    }));
  }

  if (intent.mode === "month-extremes" && analysis) {
    if (vi) return [
      { title: `Cao nhất: ${analysis.highest.label}`, detail: `${analysis.metric} đạt ${formatNumber(analysis.highest.value)}. ${analysis.highest.reasons.join(" ")}` },
      { title: `Thấp nhất: ${analysis.lowest.label}`, detail: `${analysis.metric} đạt ${formatNumber(analysis.lowest.value)}. ${analysis.lowest.reasons.join(" ")}` }
    ];
    return [
      { title: `Highest: ${analysis.highest.label}`, detail: `${analysis.metric} reached ${formatNumber(analysis.highest.value)}. ${analysis.highest.reasons.join(" ")}` },
      { title: `Lowest: ${analysis.lowest.label}`,   detail: `${analysis.metric} reached ${formatNumber(analysis.lowest.value)}. ${analysis.lowest.reasons.join(" ")}` }
    ];
  }

  const metric = intent.primaryMetric;
  const dim    = intent.primaryDimension;
  if (!metric || !rows.length) return [];

  const sorted   = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const total    = rows.reduce((s, r) => s + numericValue(r[metric]), 0);
  const avg      = total / rows.length;
  const top      = sorted[0];
  const bottom   = sorted[sorted.length - 1];
  const topLabel    = top    && dim ? String(top[dim]    ?? "") : "Top";
  const bottomLabel = bottom && dim ? String(bottom[dim] ?? "") : "Bottom";
  const topVal      = top    ? numericValue(top[metric])    : 0;
  const bottomVal   = bottom ? numericValue(bottom[metric]) : 0;
  const topShare    = total  ? (topVal / total * 100).toFixed(1) : "0";

  return [
    {
      title: vi ? `Dẫn đầu: ${topLabel}` : `Leader: ${topLabel}`,
      detail: vi
        ? `${metric}: ${formatMetricValue(metric, topVal)} (${topShare}% tổng · gấp ${avg ? (topVal/avg).toFixed(1) : "?"}× trung bình)`
        : `${metric}: ${formatMetricValue(metric, topVal)} (${topShare}% of total · ${avg ? (topVal/avg).toFixed(1) : "?"}× average)`
    },
    {
      title: vi ? `Thấp nhất: ${bottomLabel}` : `Lowest: ${bottomLabel}`,
      detail: vi
        ? `${metric}: ${formatMetricValue(metric, bottomVal)}. Chênh lệch với dẫn đầu: ${formatMetricValue(metric, topVal - bottomVal)}`
        : `${metric}: ${formatMetricValue(metric, bottomVal)}. Gap to leader: ${formatMetricValue(metric, topVal - bottomVal)}`
    }
  ];
}

// ═══════════════════════════════════════════════════════
// Executive insight engine
// ═══════════════════════════════════════════════════════

function buildBusinessInsightModel(intent: ReportIntent, analysis: any, rows: any[], columns: string[]) {
  const vi = intent.language === "vi";
  const metric = analysis?.metric ?? intent.primaryMetric ?? firstNumericColumn(rows, columns);
  const dimension = analysis?.dimension ?? intent.primaryDimension;
  const dataProfile = buildDataProfile(rows, columns, metric);
  const contributions = metric ? buildContributionInsights(rows, columns, metric, dataProfile) : [];
  const crossPockets = metric ? buildCrossDimensionPockets(rows, columns, metric, dataProfile) : [];
  const risks = metric ? buildRiskAndOpportunityWatch(rows, columns, metric, dataProfile) : [];
  const insightCards = buildExecutiveInsightCards({ intent, analysis, rows, columns, metric, dimension, dataProfile, contributions, crossPockets, risks, vi });
  const nextQuestions = buildNextBestQuestions({ intent, metric, dimension, dataProfile, contributions, crossPockets, risks, vi });

  return {
    mode: intent.mode,
    metric,
    dimension,
    dataProfile,
    insightCards,
    contributions,
    crossPockets,
    risks,
    nextQuestions
  };
}

function buildDataProfile(rows: any[], columns: string[], metric?: string) {
  const numericColumns = columns.filter(c => rows.some(r => typeof r[c] === "number"));
  const dimensionColumns = detectDimensionColumns(rows, columns);
  const scoped = rows.some(r => r.Scope !== undefined);
  const scopeCounts = scoped
    ? Object.fromEntries(unique(rows.map(r => String(r.Scope ?? "Unscoped"))).map(scope => [scope, rows.filter(r => String(r.Scope ?? "Unscoped") === scope).length]))
    : {};
  const driverColumns = numericColumns.filter(c => c !== metric);
  const missing = [];
  for (const item of [
    ["Plan/Target", ["plan","target","budget","quota"]],
    ["Margin", ["margin","profit","ebit"]],
    ["Inventory", ["inventory","stock"]],
    ["Discount", ["discount","rebate"]],
    ["Marketing/Campaign", ["marketing","campaign","promotion"]],
    ["Dealer/Channel", ["dealer","channel"]],
    ["Market share", ["marketshare","share"]]
  ]) {
    const [label, tokens] = item;
    if (!findColumnByTokens(columns, tokens)) missing.push(label);
  }
  return {
    rowCount: rows.length,
    columnCount: columns.length,
    scoped,
    scopeCounts,
    numericColumns,
    dimensionColumns,
    driverColumns,
    missingForDeeperWhy: missing
  };
}

function detectDimensionColumns(rows: any[], columns: string[]) {
  if (columns.includes("Dimension") && columns.includes("Member")) {
    const scopedDims = unique(rows.map(r => String(r.Dimension ?? "").trim()).filter(Boolean));
    if (scopedDims.length) return scopedDims;
  }
  return columns.filter(c => {
    if (["Scope","Dimension","Member","DataSource","EvidenceRole","WorkspaceName","SemanticModelName"].includes(c)) return false;
    if (rows.some(r => typeof r[c] !== "string")) return false;
    const uniqueCount = unique(rows.map(r => String(r[c] ?? "").trim()).filter(Boolean)).length;
    return uniqueCount >= 2;
  });
}

function buildContributionInsights(rows: any[], columns: string[], metric: string, dataProfile: any) {
  const total = businessMetricTotal(rows, metric);
  const insights = [];

  if (columns.includes("Dimension") && columns.includes("Member")) {
    for (const dim of unique(rows.filter(r => String(r.Scope ?? "") !== "Cross").map(r => String(r.Dimension ?? "")).filter(Boolean))) {
      const dimRows = rows.filter(r => String(r.Scope ?? "") !== "Cross" && String(r.Dimension ?? "") === dim);
      const grouped = groupMetric(dimRows, "Member", metric).filter(i => i.label && i.value !== 0).sort((a, b) => b.value - a.value);
      const item = contributionInsightFromGrouped(dim, grouped, total, metric);
      if (item) insights.push(item);
    }
    return insights.slice(0, 8);
  }

  for (const dim of dataProfile.dimensionColumns) {
    const grouped = groupMetric(rows, dim, metric).filter(i => i.label && i.value !== 0).sort((a, b) => b.value - a.value);
    const item = contributionInsightFromGrouped(dim, grouped, total, metric);
    if (item) insights.push(item);
  }
  return insights.slice(0, 8);
}

function contributionInsightFromGrouped(dimension: string, grouped: any[], total: number, metric: string) {
  if (grouped.length < 2) return undefined;
  const top = grouped[0];
  const bottom = grouped[grouped.length - 1];
  const top3 = grouped.slice(0, 3);
  const top3Value = top3.reduce((s, item) => s + item.value, 0);
  const topShare = total ? top.value / total : 0;
  const top3Share = total ? top3Value / total : 0;
  return {
    dimension,
    metric,
    topLabel: top.label,
    topValue: top.value,
    topShare,
    bottomLabel: bottom.label,
    bottomValue: bottom.value,
    itemCount: grouped.length,
    top3: top3.map(item => ({ label: item.label, value: item.value, share: total ? item.value / total : 0 })),
    concentration: top3Share,
    read: top3Share >= 0.6 ? "Concentration risk" : topShare >= 0.2 ? "Scale contributor" : "Distributed contribution"
  };
}

function buildCrossDimensionPockets(rows: any[], columns: string[], metric: string, dataProfile: any) {
  if (columns.includes("Dimension") && columns.includes("Member")) {
    return rows
      .filter(r => String(r.Scope ?? "") === "Cross")
      .map(r => buildPocketFromRow(String(r.Dimension ?? "Cross"), String(r.Member ?? ""), r, metric, rows))
      .filter(Boolean)
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);
  }

  const dims = dataProfile.dimensionColumns.filter(dim => rows.some(r => String(r[dim] ?? "").trim()));
  const pairs = [];
  for (let i = 0; i < dims.length; i += 1) {
    for (let j = i + 1; j < dims.length; j += 1) {
      pairs.push([dims[i], dims[j]]);
    }
  }
  return pairs.slice(0, 4).flatMap(([a, b]) => {
    const groups = new Map();
    for (const r of rows) {
      const av = String(r[a] ?? "").trim();
      const bv = String(r[b] ?? "").trim();
      if (!av || !bv) continue;
      const label = `${av} / ${bv}`;
      groups.set(label, {
        dimension: `${a} x ${b}`,
        label,
        value: (groups.get(label)?.value ?? 0) + numericValue(r[metric])
      });
    }
    const total = businessMetricTotal(rows, metric);
    return [...groups.values()].map(item => ({
      ...item,
      metric,
      share: total ? item.value / total : 0,
      cue: item.value / Math.max(total, 1) >= 0.1 ? "Scale or protect" : "Drill if margin/growth is attractive",
      evidence: [`${formatMetricValue(metric, item.value)}`, `${formatPercent(total ? item.value / total : 0)} share`]
    })).sort((x, y) => y.value - x.value).slice(0, 4);
  }).sort((x, y) => y.value - x.value).slice(0, 12);
}

function buildPocketFromRow(dimension: string, label: string, row: any, metric: string, rows: any[]) {
  if (!label) return undefined;
  const total = businessMetricTotal(rows, metric);
  const value = numericValue(row[metric]);
  const marginCol = findColumnByTokens(Object.keys(row), ["margin"]);
  const unitsCol = findColumnByTokens(Object.keys(row), ["unit","quantity","sold"]);
  const discountCol = findColumnByTokens(Object.keys(row), ["discount"]);
  const margin = marginCol ? numericValue(row[marginCol]) : undefined;
  const units = unitsCol ? numericValue(row[unitsCol]) : undefined;
  const discount = discountCol ? numericValue(row[discountCol]) : undefined;
  return {
    dimension,
    label,
    metric,
    value,
    share: total ? value / total : 0,
    margin,
    units,
    discount,
    cue: crossActionCue(row, metric),
    evidence: [
      formatMetricValue(metric, value),
      total ? `${formatPercent(value / total)} share` : undefined,
      margin !== undefined ? `margin ${formatMetricValue(marginCol, margin)}` : undefined,
      units !== undefined ? `${formatNumber(units)} units` : undefined
    ].filter(Boolean)
  };
}

function buildRiskAndOpportunityWatch(rows: any[], columns: string[], metric: string, dataProfile: any) {
  const riskRows = columns.includes("Dimension") && columns.includes("Member")
    ? rows.filter(r => String(r.Scope ?? "") !== "Monthly")
    : rows;
  if (!riskRows.length) return [];

  const invCol = findColumnByTokens(columns, ["inventory","stock"]);
  const discountCol = findColumnByTokens(columns, ["discount","rebate"]);
  const marginCol = findColumnByTokens(columns, ["margin","profit"]);
  const marketingCol = findColumnByTokens(columns, ["marketing","campaign","promotion"]);
  const shareCol = findColumnByTokens(columns, ["marketshare","share"]);
  const avgValue = average(riskRows.map(r => numericValue(r[metric])));

  return riskRows.map(r => {
    const label = columns.includes("Dimension") && columns.includes("Member")
      ? [r.Dimension, r.Member].filter(Boolean).join(": ")
      : labelForRow(r, dataProfile.dimensionColumns);
    const value = numericValue(r[metric]);
    const flags = [];
    let score = 0;
    if (value >= avgValue * 1.5) {
      flags.push("high contribution");
      score += 1;
    }
    if (marginCol && numericValue(r[marginCol]) > 0 && numericValue(r[marginCol]) < 0.16) {
      flags.push("margin below guardrail");
      score += 3;
    }
    if (discountCol && value && numericValue(r[discountCol]) / Math.abs(value) > 0.04) {
      flags.push("discount leakage");
      score += 2;
    }
    if (invCol && numericValue(r[invCol]) > 42) {
      flags.push("inventory pressure");
      score += 2;
    }
    if (marketingCol && value && numericValue(r[marketingCol]) / Math.abs(value) > 0.025) {
      flags.push("marketing intensity high");
      score += 1;
    }
    if (shareCol && numericValue(r[shareCol]) > 0 && numericValue(r[shareCol]) < 10) {
      flags.push("weak share");
      score += 1;
    }
    if (!flags.length && value >= avgValue) {
      flags.push("scale candidate");
      score += 0.5;
    }
    return {
      label,
      value,
      metric,
      score,
      severity: score >= 4 ? "high" : score >= 2 ? "medium" : "watch",
      flags,
      read: flags.length ? flags.join("; ") : "monitor for next drill-down"
    };
  }).filter(item => item.label).sort((a, b) => b.score - a.score || b.value - a.value).slice(0, 10);
}

function labelForRow(row: any, dimensions: string[]) {
  const parts = dimensions.slice(0, 2).map(dim => String(row[dim] ?? "").trim()).filter(Boolean);
  return parts.join(" / ") || "Returned row";
}

function buildExecutiveInsightCards(context: any) {
  const { intent, analysis, rows, metric, dimension, dataProfile, contributions, crossPockets, risks, vi } = context;
  const total = metric ? rows.reduce((s, r) => s + numericValue(r[metric]), 0) : 0;
  const cards = [];

  if (analysis) {
    cards.push({
      type: "what",
      confidence: "high",
      what: vi ? `WHAT: ${analysis.highest.label} cao nhất, ${analysis.lowest.label} thấp nhất` : `WHAT: ${analysis.highest.label} highest, ${analysis.lowest.label} lowest`,
      why: vi ? `WHY: chênh lệch ${formatMetricValue(metric, analysis.spread)}; ${analysis.highest.reasons[0] ?? ""}` : `WHY: spread ${formatMetricValue(metric, analysis.spread)}; ${analysis.highest.reasons[0] ?? ""}`,
      soWhat: vi ? "SO WHAT: đây là biến động cần phân rã theo volume, ASP/mix và các slice tỉnh/model/kênh." : "SO WHAT: this variance should be decomposed by volume, ASP/mix, and province/model/channel slices.",
      action: vi ? "NOW WHAT: drill vào các pocket đóng góp lớn trước khi quyết định tăng ngân sách hoặc giá." : "NOW WHAT: drill into top pockets before changing budget or price.",
      evidence: [analysis.dimension, analysis.metric, analysis.highest.label, analysis.lowest.label],
      missingForDeeperWhy: dataProfile.missingForDeeperWhy
    });
  }

  const leadContribution = contributions.find(item => !isTimeDimensionName(item.dimension)) ?? contributions[0];
  if (leadContribution) {
    cards.push({
      type: "contribution",
      confidence: "high",
      what: vi ? `WHAT: ${leadContribution.dimension} dẫn dắt bởi ${leadContribution.topLabel}` : `WHAT: ${leadContribution.dimension} led by ${leadContribution.topLabel}`,
      why: vi
        ? `WHY: ${leadContribution.topLabel} đóng góp ${formatMetricValue(metric, leadContribution.topValue)} (${formatPercent(leadContribution.topShare)} tổng).`
        : `WHY: ${leadContribution.topLabel} contributes ${formatMetricValue(metric, leadContribution.topValue)} (${formatPercent(leadContribution.topShare)} of total).`,
      soWhat: vi
        ? `${leadContribution.concentration >= 0.6 ? "SO WHAT: rủi ro tập trung cao, cần bảo vệ nguồn tăng trưởng này." : "SO WHAT: có dư địa nhân rộng playbook sang nhóm kế tiếp."}`
        : `${leadContribution.concentration >= 0.6 ? "SO WHAT: high concentration risk, protect this growth pool." : "SO WHAT: room to replicate playbook into the next cohort."}`,
      action: vi ? `NOW WHAT: so sánh margin, tồn kho và discount của top ${leadContribution.dimension}.` : `NOW WHAT: compare margin, inventory, and discount for top ${leadContribution.dimension}.`,
      evidence: leadContribution.top3.map(i => `${i.label}: ${formatMetricValue(metric, i.value)}`),
      missingForDeeperWhy: dataProfile.missingForDeeperWhy
    });
  }

  const leadPocket = crossPockets[0];
  if (leadPocket) {
    cards.push({
      type: "cross-dimension",
      confidence: leadPocket.evidence.length >= 3 ? "medium" : "directional",
      what: vi ? `WHAT: pocket mạnh nhất là ${leadPocket.label}` : `WHAT: strongest pocket is ${leadPocket.label}`,
      why: vi ? `WHY: ${leadPocket.evidence.join(" · ")}.` : `WHY: ${leadPocket.evidence.join(" · ")}.`,
      soWhat: vi ? "SO WHAT: insight quyết định thường nằm ở giao điểm dimension, không nằm ở ranking đơn lẻ." : "SO WHAT: decision insight usually lives at dimension intersections, not single rankings.",
      action: vi ? `NOW WHAT: ${leadPocket.cue}.` : `NOW WHAT: ${leadPocket.cue}.`,
      evidence: leadPocket.evidence,
      missingForDeeperWhy: dataProfile.missingForDeeperWhy
    });
  }

  const topRisk = risks[0];
  if (topRisk) {
    cards.push({
      type: "risk-opportunity",
      confidence: topRisk.score >= 2 ? "medium" : "directional",
      what: vi ? `WHAT: watchlist ưu tiên ${topRisk.label}` : `WHAT: priority watchlist ${topRisk.label}`,
      why: vi ? `WHY: ${topRisk.read}; ${formatMetricValue(metric, topRisk.value)}.` : `WHY: ${topRisk.read}; ${formatMetricValue(metric, topRisk.value)}.`,
      soWhat: vi ? "SO WHAT: tăng trưởng không đủ tốt nếu đi kèm margin leakage, tồn kho hoặc discount cao." : "SO WHAT: growth is not enough if paired with margin leakage, inventory pressure, or heavy discounting.",
      action: vi ? "NOW WHAT: drill xuống dealer/campaign/inventory trước khi scale." : "NOW WHAT: drill into dealer/campaign/inventory before scaling.",
      evidence: [topRisk.label, topRisk.read, formatMetricValue(metric, topRisk.value)],
      missingForDeeperWhy: dataProfile.missingForDeeperWhy
    });
  }

  if (!cards.length && metric) {
    cards.push({
      type: "baseline",
      confidence: "directional",
      what: vi ? `WHAT: ${metric} tổng ${formatMetricValue(metric, total)}` : `WHAT: ${metric} totals ${formatMetricValue(metric, total)}`,
      why: vi ? `WHY: query trả ${rows.length} dòng và ${dataProfile.dimensionColumns.length} dimension có thể phân tích.` : `WHY: query returned ${rows.length} rows and ${dataProfile.dimensionColumns.length} analyzable dimensions.`,
      soWhat: vi ? "SO WHAT: đủ để đọc overview, chưa đủ để kết luận root cause sâu." : "SO WHAT: enough for overview, not enough for deep root cause.",
      action: vi ? "NOW WHAT: thêm plan, margin, inventory, campaign, dealer để ra quyết định tốt hơn." : "NOW WHAT: add plan, margin, inventory, campaign, dealer for stronger decisions.",
      evidence: [metric, `${rows.length} rows`],
      missingForDeeperWhy: dataProfile.missingForDeeperWhy
    });
  }

  return cards.slice(0, 6);
}

function buildNextBestQuestions(context: any) {
  const { intent, metric, dimension, dataProfile, contributions, crossPockets, risks, vi } = context;
  const leadDim = (contributions.find(item => !isTimeDimensionName(item.dimension)) ?? contributions[0])?.dimension ?? dimension ?? "dimension";
  const leadPocket = crossPockets[0]?.label;
  const risk = risks[0]?.label;
  const questions = [];

  questions.push(vi
    ? `${leadDim} nào đóng góp nhiều nhất vào tăng trưởng và margin có bền vững không?`
    : `Which ${leadDim} contributes most to growth, and is its margin sustainable?`);
  if (leadPocket) {
    questions.push(vi
      ? `Vì sao pocket ${leadPocket} nổi bật, có thể nhân rộng sang tỉnh/model nào?`
      : `Why does pocket ${leadPocket} stand out, and where can it be replicated?`);
  }
  if (risk) {
    questions.push(vi
      ? `${risk} là rủi ro thật hay chỉ là hiệu ứng mix dữ liệu?`
      : `Is ${risk} a true risk or a data-mix effect?`);
  }
  if (!dataProfile.missingForDeeperWhy.some(item => /Plan|Target/i.test(item))) {
    questions.push(vi ? `${metric} đang lệch plan ở đâu và do driver nào?` : `Where is ${metric} off plan, and which driver explains it?`);
  } else {
    questions.push(vi ? `Nếu thêm plan/target, slice nào đang thiếu kế hoạch nhiều nhất?` : `With plan/target added, which slice misses plan the most?`);
  }
  return unique(questions).slice(0, 5);
}

function isTimeDimensionName(value: string): boolean {
  const n = normalizeForMatch(value);
  return ["month","yearmonth","period","date","thang"].some(token => n.includes(token));
}

function renderBusinessInsightSection(business: any): string {
  if (!business) return "";
  const cards = business.insightCards ?? [];
  const contributions = business.contributions ?? [];
  const pockets = business.crossPockets ?? [];
  const risks = business.risks ?? [];
  const nextQuestions = business.nextQuestions ?? [];
  const profile = business.dataProfile ?? {};
  if (!cards.length && !contributions.length && !pockets.length && !risks.length) return "";

  return `<section class="analysis-stack">
    <article class="panel">
      <h2>Executive insight layers</h2>
      <p class="analysis-note">Decision-first readout generated from returned measures and dimensions. Raw rows stay in MCP structuredContent for auditability, not as the main report view.</p>
      <div class="heat-grid">
        ${cards.map(card => `<div class="heat-cell ${card.type === "risk-opportunity" ? "risk" : card.type === "cross-dimension" ? "warn" : "scale"}">
          <b>${escapeHtml(card.what)}</b>
          <span>${escapeHtml(card.why)}</span>
          <span>${escapeHtml(card.soWhat)}</span>
          <span>${escapeHtml(card.action)}</span>
          <span>Confidence: ${escapeHtml(card.confidence)} · Evidence: ${escapeHtml((card.evidence ?? []).slice(0, 3).join(" | "))}</span>
        </div>`).join("")}
      </div>
    </article>

    <section class="analysis-grid">
      ${renderContributionLayer(contributions)}
      ${renderPocketLayer(pockets)}
      ${renderRiskLayer(risks)}
      ${renderDataProfileLayer(profile, nextQuestions)}
    </section>
  </section>`;
}

function renderContributionLayer(contributions: any[]): string {
  if (!contributions.length) return "";
  return `<article class="panel">
    <h2>Contribution analysis</h2>
    <p class="analysis-note">Shows which dimension actually moves the business outcome.</p>
    <div class="visual-grid">
      ${contributions.slice(0, 6).map(item => {
        const width = Math.max(4, Math.round((item.topShare || 0) * 100));
        return `<div class="visual-row">
          <div class="visual-name">${escapeHtml(item.dimension)}<span class="visual-sub">${escapeHtml(item.read)} · ${escapeHtml(item.itemCount)} members</span></div>
          <div class="track"><div class="fill" style="width:${width}%"></div></div>
          <div class="visual-metric">${escapeHtml(formatPercent(item.topShare))}<span class="visual-sub">${escapeHtml(item.topLabel)} · ${escapeHtml(formatMetricValue(item.metric, item.topValue))}</span></div>
        </div>`;
      }).join("")}
    </div>
  </article>`;
}

function renderPocketLayer(pockets: any[]): string {
  if (!pockets.length) return "";
  return `<article class="panel">
    <h2>Cross-dimension pockets</h2>
    <p class="analysis-note">Business insight often lives in combinations such as Province x Model or Region x Dealer.</p>
    <div class="heat-grid">
      ${pockets.slice(0, 8).map(item => {
        const tone = item.cue?.includes("Fix") ? "risk" : item.cue?.includes("Audit") ? "warn" : "scale";
        return `<div class="heat-cell ${tone}">
          <b>${escapeHtml(item.label)}</b>
          <span>${escapeHtml(item.dimension)} · ${escapeHtml(formatMetricValue(item.metric ?? "metric", item.value))} · ${escapeHtml(formatPercent(item.share || 0))}</span>
          <span>${escapeHtml(item.cue ?? "")}</span>
        </div>`;
      }).join("")}
    </div>
  </article>`;
}

function renderRiskLayer(risks: any[]): string {
  if (!risks.length) return "";
  return `<article class="panel">
    <h2>Risk and opportunity watch</h2>
    <p class="analysis-note">Flags scale candidates and slices that need operational drill-down.</p>
    <div class="alert-grid">
      ${risks.slice(0, 8).map(item => `<div class="alert-card ${item.severity === "high" ? "high" : item.severity === "watch" ? "ok" : ""}">
        <b>${escapeHtml(item.label)}</b>
        <p>${escapeHtml(item.read)}</p>
        <p>${escapeHtml(formatMetricValue(item.metric ?? "metric", item.value))}</p>
      </div>`).join("")}
    </div>
  </article>`;
}

function renderDataProfileLayer(profile: any, nextQuestions: string[]): string {
  return `<article class="panel">
    <h2>Evidence and next questions</h2>
    <div class="driver-tree">
      <div class="tree-row"><span>Rows / columns</span><strong>${escapeHtml(formatNumber(profile.rowCount ?? 0))} / ${escapeHtml(formatNumber(profile.columnCount ?? 0))}</strong></div>
      <div class="tree-row"><span>Detected dimensions</span><strong>${escapeHtml((profile.dimensionColumns ?? []).slice(0, 5).join(", ") || "n/a")}</strong></div>
      <div class="tree-row"><span>Detected measures</span><strong>${escapeHtml((profile.numericColumns ?? []).slice(0, 5).join(", ") || "n/a")}</strong></div>
      <div class="tree-row"><span>Missing for deeper why</span><strong>${escapeHtml((profile.missingForDeeperWhy ?? []).slice(0, 4).join(", ") || "none")}</strong></div>
    </div>
    ${nextQuestions.length ? `<div style="margin-top:14px" class="driver-tree">${nextQuestions.map(q => `<div class="tree-row"><span>${escapeHtml(q)}</span><strong>Next</strong></div>`).join("")}</div>` : ""}
  </article>`;
}

function renderDecisionCards(rows: any[]): string {
  if (!rows?.length) return "<p>No decision rows available.</p>";
  return `<div class="decision-cards">${rows.map(row => `<div class="decision-card">
    <b>${escapeHtml(row.question)}</b>
    <span>Evidence</span><p>${escapeHtml(row.evidence)}</p>
    <span>Management read</span><p>${escapeHtml(row.decision)}</p>
    <span>Still missing</span><p>${escapeHtml(row.missing)}</p>
  </div>`).join("")}</div>`;
}

function renderDataSourceSection(input: any): string {
  const sources = input.dataSources ?? [];
  const warnings = input.validationWarnings ?? [];
  const joinPlan = input.joinPlan;
  if (!sources.length && !warnings.length && !joinPlan) return "";
  return `<section class="panel">
    <h2>Data sources and evidence quality</h2>
    ${sources.length ? `<div class="source-list">${sources.map(source => `<div class="source-card">
      <b>${escapeHtml(source.semanticModelName ?? source.name ?? "Semantic model")}</b>
      <span>Workspace: ${escapeHtml(source.workspaceName ?? "")}</span>
      <span>Evidence: ${escapeHtml((source.evidence ?? source.evidenceRole ?? []).toString())}</span>
      <span>Rows: ${escapeHtml(formatNumber(source.rowCount ?? 0))}</span>
    </div>`).join("")}</div>` : ""}
    ${joinPlan ? `<div style="margin-top:14px" class="driver-tree">
      <div class="tree-row"><span>Join grain</span><strong>${escapeHtml(joinPlan.grain ?? "not specified")}</strong></div>
      <div class="tree-row"><span>Join keys</span><strong>${escapeHtml((joinPlan.joinKeys ?? []).join(", ") || "not specified")}</strong></div>
      <div class="tree-row"><span>Confidence</span><strong>${escapeHtml(joinPlan.confidence ?? "directional")}</strong></div>
    </div>` : ""}
    ${warnings.length ? `<div style="margin-top:14px" class="driver-tree">${warnings.map(warning => `<div class="tree-row"><span>${escapeHtml(warning)}</span><strong>Warning</strong></div>`).join("")}</div>` : ""}
  </section>`;
}

function renderDatasetEvidenceSection(input: any): string {
  const datasets = input.datasets ?? [];
  const profiles = input.datasetProfiles ?? [];
  if (!datasets.length || !profiles.length) return "";
  const joinPlan = input.joinPlan ?? {};
  const alignmentRead = (joinPlan.joinKeys ?? []).length
    ? `Common grain requested: ${joinPlan.grain ?? (joinPlan.joinKeys ?? []).join(" x ")}. Cross-source conclusions should use only those keys.`
    : "No common join keys were supplied, so each semantic model is treated as a separate evidence block. The report should compare patterns, not claim direct causality.";

  return `<section class="analysis-stack">
    <article class="panel">
      <h2>Question-driven report framework</h2>
      <p class="analysis-note">The dashboard format is selected from each dataset's actual shape: time series, ranking, cross-dimension pocket, metric scorecard, or evidence table. This avoids forcing different semantic models into one incorrect visual grain.</p>
      <div class="driver-tree">
        <div class="tree-row"><span>Rendering mode</span><strong>Dataset-specific evidence blocks</strong></div>
        <div class="tree-row"><span>Cross-source alignment</span><strong>${escapeHtml(joinPlan.confidence ?? "directional")}</strong></div>
        <div class="tree-row"><span>Management read</span><strong>${escapeHtml(alignmentRead)}</strong></div>
      </div>
    </article>
    <section class="dataset-grid">
      ${profiles.map((profile, index) => renderDatasetBlock(datasets[index], profile)).join("")}
    </section>
    ${renderCrossDatasetInsightBoard(datasets, profiles)}
  </section>`;
}

function renderDatasetBlock(dataset: any, profile: any): string {
  const rows = dataset?.rows ?? [];
  const metric = profile.primaryMetric;
  const dimension = profile.primaryDimension;
  const chart = renderDatasetChart(rows, profile);
  const profileRows = [
    ["Shape", profile.shape.replace(/_/g, " ")],
    ["Grain", profile.grain],
    ["Rows / columns", `${formatNumber(profile.rowCount)} / ${formatNumber(profile.columnCount)}`],
    ["Metric", metric ?? "not detected"],
    ["Dimension", dimension ?? "not detected"]
  ];
  return `<article class="panel dataset-panel">
    <div class="dataset-head">
      <div>
        <div class="mode-badge">${escapeHtml(profile.evidenceRole ?? "evidence")}</div>
        <h2>${escapeHtml(profile.label)}</h2>
      </div>
      <span>${escapeHtml(profile.workspaceName ?? "")}</span>
    </div>
    <p class="analysis-note">${escapeHtml(datasetReadout(profile))}</p>
    ${chart}
    <div class="driver-tree" style="margin-top:14px">
      ${profileRows.map(([label, value]) => `<div class="tree-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </div>
  </article>`;
}

function renderDatasetChart(rows: any[], profile: any): string {
  const metric = profile.primaryMetric;
  const dimension = profile.primaryDimension;
  if (!rows.length) return "<p>No rows returned from this semantic model.</p>";
  if (!metric) return renderEvidenceTable(rows, profile.columns, 8);
  if (profile.shape === "time_series" && dimension) return renderTrendBars(rows, dimension, metric);
  if ((profile.shape === "categorical_ranking" || profile.shape === "cross_dimension") && dimension) {
    return renderGenericBars(aggregateRowsByDimension(rows, dimension, metric), dimension, metric, 10);
  }
  if (profile.shape === "multi_metric" || profile.shape === "single_metric") return renderMetricScorecard(rows, profile.metrics);
  return renderEvidenceTable(rows, profile.columns, 8);
}

function renderMetricScorecard(rows: any[], metrics: string[]): string {
  const selected = metrics.slice(0, 6);
  if (!selected.length) return "<p>No numeric measures available.</p>";
  return `<div class="mini-cards">${selected.map(metric => {
    const values = rows.map(row => numericValue(row[metric]));
    const total = values.reduce((sum, value) => sum + value, 0);
    const avg = values.length ? total / values.length : 0;
    return `<div class="mini-card"><span>${escapeHtml(metric)}</span><strong>${escapeHtml(formatMetricValue(metric, total))}</strong><p>Average ${escapeHtml(formatMetricValue(metric, avg))} across ${escapeHtml(formatNumber(rows.length))} rows.</p></div>`;
  }).join("")}</div>`;
}

function renderEvidenceTable(rows: any[], columns: string[], limit = 8): string {
  const visibleColumns = (columns?.length ? columns : unique(rows.flatMap(row => Object.keys(row)))).slice(0, 6);
  if (!visibleColumns.length) return "<p>No table columns available.</p>";
  return `<div class="table-wrap"><table><thead><tr>${visibleColumns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>
    ${rows.slice(0, limit).map(row => `<tr>${visibleColumns.map(column => {
      const value = row[column];
      const isNumber = typeof value === "number";
      return `<td class="${isNumber ? "number" : ""}">${escapeHtml(isNumber ? formatMetricValue(column, value) : String(value ?? ""))}</td>`;
    }).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

function renderCrossDatasetInsightBoard(datasets: any[], profiles: any[]): string {
  const rows = profiles.map((profile, index) => {
    const dataset = datasets[index] ?? {};
    const metric = profile.primaryMetric;
    const dimension = profile.primaryDimension;
    const evidence = metric && dimension
      ? topDatasetEvidence(dataset.rows ?? [], dimension, metric)
      : metric
        ? `Total ${metric}: ${formatMetricValue(metric, sumRows(dataset.rows ?? [], metric))}`
        : "No primary metric detected";
    const decision = decisionCueForShape(profile);
    return { source: profile.label, evidence, decision, missing: missingEvidenceForProfile(profile) };
  });
  return `<article class="panel">
    <h2>Executive synthesis board</h2>
    <p class="analysis-note">This is the management layer: what each semantic model can prove, what decision it supports, and what is still missing before claiming root cause.</p>
    <div class="table-wrap"><table class="decision-table"><thead><tr><th>Evidence source</th><th>What it proves</th><th>Decision use</th><th>Still missing</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.evidence)}</td><td>${escapeHtml(row.decision)}</td><td>${escapeHtml(row.missing)}</td></tr>`).join("")}
    </tbody></table></div>
  </article>`;
}

function datasetReadout(profile: any): string {
  if (profile.shape === "time_series") return `Use this block for trend, seasonality, extremes, and run-rate questions at ${profile.grain} grain.`;
  if (profile.shape === "categorical_ranking") return `Use this block for top/bottom, concentration, and contribution decisions by ${profile.primaryDimension}.`;
  if (profile.shape === "cross_dimension") return `Use this block to find business pockets across dimensions instead of reading dimensions independently.`;
  if (profile.shape === "multi_metric") return "Use this block as a driver scorecard; it needs a dimension or time grain for deeper diagnosis.";
  if (profile.shape === "empty") return "This evidence source returned no rows and should be treated as a data gap.";
  return "Use this block as supporting evidence; add dimensions or metrics to make it decision-ready.";
}

function topDatasetEvidence(rows: any[], dimension: string, metric: string): string {
  const grouped = aggregateRowsByDimension(rows, dimension, metric).sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const total = grouped.reduce((sum, row) => sum + numericValue(row[metric]), 0);
  const top = grouped[0];
  if (!top) return "No comparable members returned";
  const value = numericValue(top[metric]);
  return `${String(top[dimension] ?? "")} leads ${metric} with ${formatMetricValue(metric, value)}${total ? ` (${formatPercent(value / total)})` : ""}.`;
}

function decisionCueForShape(profile: any): string {
  if (profile.shape === "time_series") return "Validate whether peak/trough is repeatable, seasonal, or operational before acting.";
  if (profile.shape === "categorical_ranking") return "Prioritize top contributors, then check margin/risk before scaling.";
  if (profile.shape === "cross_dimension") return "Drill into the strongest pockets; these are usually where CEO-level actions live.";
  if (profile.shape === "multi_metric") return "Use as a driver scan; request segmentation to locate where the driver matters.";
  if (profile.shape === "empty") return "Do not use this source for decisions until the query/model returns data.";
  return "Use as audit evidence, not the main decision layer.";
}

function missingEvidenceForProfile(profile: any): string {
  const missing = [];
  if (!profile.timeDimensions?.length) missing.push("time grain");
  if (!profile.categoricalDimensions?.length) missing.push("business dimension");
  if ((profile.metrics ?? []).length < 2) missing.push("secondary driver metric");
  return missing.length ? missing.join(", ") : "root-cause fields such as plan, margin, inventory, discount, campaign";
}

function aggregateRowsByDimension(rows: any[], dimension: string, metric: string): any[] {
  const groups = new Map();
  for (const row of rows) {
    const label = String(row[dimension] ?? "").trim();
    if (!label) continue;
    groups.set(label, (groups.get(label) ?? 0) + numericValue(row[metric]));
  }
  return [...groups.entries()].map(([label, value]) => ({ [dimension]: label, [metric]: value }));
}

// ═══════════════════════════════════════════════════════
// KPI cards (mode-aware)
// ═══════════════════════════════════════════════════════

function buildDatasetKpis(profiles: any[]) {
  const totalRows = profiles.reduce((sum, profile) => sum + (profile.rowCount ?? 0), 0);
  const joined = profiles.filter(profile => profile.rowCount > 0);
  const shapes = unique(profiles.map(profile => profile.shape).filter(Boolean));
  const grains = unique(profiles.map(profile => profile.grain).filter(Boolean));
  return [
    { label: "Evidence sources", value: formatNumber(profiles.length), tone: "blue" },
    { label: "Rows returned", value: formatNumber(totalRows), tone: "green" },
    { label: "Visual shapes", value: shapes.slice(0, 2).join(", ") || "n/a", tone: "amber" },
    { label: "Grains detected", value: grains.length === 1 ? grains[0] : `${formatNumber(grains.length)} separate grains`, tone: joined.length === profiles.length ? "blue" : "red" }
  ];
}

function buildKpis(rows: any[], columns: string[], intent: ReportIntent, analysis: any) {
  if (intent?.mode === "month-extremes" && analysis) {
    const monthlyRows = selectMonthlyRows(rows);
    const monthCount = unique(monthlyRows.map(r => String(r[analysis.dimension] ?? "").trim()).filter(Boolean)).length || monthlyRows.length;
    return [
      { label: `Highest ${analysis.metric}`, value: `${analysis.highest.label}: ${formatNumber(analysis.highest.value)}`, tone: "green" },
      { label: `Lowest ${analysis.metric}`,  value: `${analysis.lowest.label}: ${formatNumber(analysis.lowest.value)}`,  tone: "red"   },
      { label: "Spread",  value: formatNumber(analysis.spread), tone: "amber" },
      { label: "Months",  value: formatNumber(monthCount),       tone: "blue"  }
    ];
  }

  const metric = intent?.primaryMetric ?? columns.find(c => rows.some(r => typeof r[c] === "number"));
  const dim    = intent?.primaryDimension;
  if (!metric || !rows.length) return [{ label: "Rows", value: formatNumber(rows.length), tone: "blue" }];

  const total  = rows.reduce((s, r) => s + numericValue(r[metric]), 0);
  const avg    = total / rows.length;
  const sorted = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const top    = sorted[0];
  const btm    = sorted[sorted.length - 1];
  const topLabel = top && dim ? String(top[dim] ?? "Top") : "Top";
  const btmLabel = btm && dim ? String(btm[dim] ?? "Bottom") : "Bottom";
  const numericCols = columns.filter(c => rows.some(r => typeof r[c] === "number"));
  const second = numericCols.find(c => c !== metric);

  const kpis = [
    { label: `Total ${metric}`,        value: formatMetricValue(metric, total),                    tone: "blue"  },
    { label: `Leader: ${topLabel}`,    value: formatMetricValue(metric, numericValue(top?.[metric])), tone: "green" },
    { label: `Lowest: ${btmLabel}`,    value: formatMetricValue(metric, numericValue(btm?.[metric])), tone: "red"   },
    second
      ? { label: `Total ${second}`, value: formatMetricValue(second, rows.reduce((s, r) => s + numericValue(r[second]), 0)), tone: "amber" }
      : { label: "Average",         value: formatMetricValue(metric, avg), tone: "amber" }
  ];
  return kpis.slice(0, 4);
}

// ═══════════════════════════════════════════════════════
// HTML renderer — routes to mode sections
// ═══════════════════════════════════════════════════════

function renderDashboardHtml(input) {
  const title  = input.title || "Executive Power BI Report";
  const intent: ReportIntent = input.intent;
  const multiDatasetMode = (input.datasetProfiles?.length ?? 0) > 1;
  const kpis   = multiDatasetMode
    ? buildDatasetKpis(input.datasetProfiles)
    : buildKpis(input.rows, input.columns, intent, input.analysis);

  let modeSection = "";
  let analysisSection = "";
  let chartHtml   = "";
  const metric = intent?.primaryMetric;
  const dim    = intent?.primaryDimension;

  if (!multiDatasetMode) {
    switch (intent?.mode) {
      case "month-extremes":
        if (input.analysis) {
          modeSection = renderMonthExtremesSection(input);
          analysisSection = renderAnalysisTables(input.rows, input.analysis);
        }
        chartHtml = renderMonthlyBars(input.rows, input.analysis?.dimension, input.analysis?.metric);
        break;
      case "ranking":
        modeSection = renderRankingSection(input);
        chartHtml   = renderRankedBars(input.rows, dim, metric, intent.topN);
        break;
      case "trend":
        modeSection = renderTrendSection(input);
        chartHtml   = renderTrendBars(input.rows, dim, metric);
        break;
      case "distribution":
        modeSection = renderDistributionSection(input);
        chartHtml   = renderDistributionBars(input.rows, dim, metric);
        break;
      default:
        chartHtml = renderGenericBars(input.rows, dim, metric);
    }
  }

  const chartTitle = getChartTitle(intent, input.analysis);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b1f23; --muted: #667085; --line: #d7dde5;
      --panel: #ffffff; --canvas: #f4f7fa;
      --green: #08875d; --blue: #1769aa; --amber: #b75f00; --red: #c5352b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--canvas); color: var(--ink); }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    header { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 20px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; font-weight: 760; }
    h2 { margin: 0 0 14px; font-size: 17px; line-height: 1.25; }
    p  { margin: 0; color: var(--muted); line-height: 1.5; }
    .meta { text-align: right; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 14px; margin-bottom: 18px; }
    .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .card { min-height: 118px; padding: 16px; display: grid; align-content: space-between; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .value { font-size: 27px; line-height: 1.15; font-weight: 760; overflow-wrap: anywhere; }
    .tone-green { border-top: 4px solid var(--green); }
    .tone-blue  { border-top: 4px solid var(--blue);  }
    .tone-amber { border-top: 4px solid var(--amber); }
    .tone-red   { border-top: 4px solid var(--red);   }
    .content { display: grid; grid-template-columns: minmax(0,1.1fr) minmax(360px,0.9fr); gap: 18px; align-items: start; }
    .panel { padding: 18px; overflow: hidden; }
    .bars { display: grid; gap: 11px; }
    .bar-row { display: grid; grid-template-columns: minmax(120px,200px) minmax(0,1fr) minmax(86px,auto); gap: 12px; align-items: center; }
    .bar-label { font-size: 13px; color: #344054; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { height: 12px; border-radius: 999px; background: #e8eef5; overflow: hidden; }
    .fill  { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--blue), var(--green)); }
    .fill.down { background: linear-gradient(90deg, var(--amber), var(--red)); }
    .bar-value { font-size: 13px; font-weight: 700; text-align: right; }
    .insights { display: grid; gap: 10px; margin-bottom: 18px; }
    .insight { background: var(--panel); border-left: 4px solid var(--blue); padding: 14px 16px; border-radius: 8px; border: 1px solid var(--line); border-left-width: 4px; }
    .insight strong { display: block; margin-bottom: 5px; }
    .exec-grid { display: grid; grid-template-columns: minmax(0,1.08fr) minmax(360px,0.92fr); gap: 18px; align-items: start; margin-bottom: 18px; }
    .exec-stack { display: grid; gap: 18px; }
    .readout { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; }
    .readout-item { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; min-height: 110px; }
    .readout-item span, .mini-card span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 760; margin-bottom: 6px; }
    .readout-item strong { display: block; font-size: 15px; line-height: 1.3; margin-bottom: 5px; }
    .readout-item p, .mini-card p { font-size: 12px; line-height: 1.4; }
    .driver-tree { display: grid; gap: 8px; }
    .tree-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
    .tree-row:last-child { border-bottom: 0; }
    .tree-row span { color: var(--muted); }
    .tree-row strong { text-align: right; }
    .waterfall { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; align-items: end; min-height: 210px; }
    .wf-step { display: grid; grid-template-rows: auto 1fr auto; gap: 8px; text-align: center; color: var(--muted); font-size: 12px; min-height: 190px; }
    .wf-step i { align-self: end; display: block; min-height: 12px; border-radius: 6px 6px 0 0; background: var(--blue); }
    .wf-step.good i { background: var(--green); } .wf-step.warn i { background: var(--amber); } .wf-step.bad i { background: var(--red); }
    .wf-step b { color: var(--ink); font-size: 13px; line-height: 1.25; }
    .monthly-bars { display: grid; gap: 9px; }
    .mini-cards { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
    .mini-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; }
    .mini-card strong { display: block; font-size: 20px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .dimension-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .decision-table { width: 100%; min-width: 760px; }
    .analysis-stack { display: grid; gap: 18px; margin-bottom: 18px; }
    .analysis-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; align-items: start; }
    .analysis-note { margin-bottom: 12px; font-size: 13px; color: var(--muted); }
    .visual-grid { display: grid; gap: 10px; }
    .visual-row { display: grid; grid-template-columns: minmax(150px,1fr) minmax(0,1.4fr) minmax(82px,auto); gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .visual-row:last-child { border-bottom: 0; }
    .visual-name { min-width: 0; font-weight: 700; font-size: 13px; overflow-wrap: anywhere; }
    .visual-sub { display: block; color: var(--muted); font-size: 11px; font-weight: 500; margin-top: 2px; }
    .visual-metric { text-align: right; font-weight: 760; font-size: 13px; }
    .heat-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .heat-cell { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; border-left: 5px solid var(--blue); min-height: 104px; }
    .heat-cell.risk { border-left-color: var(--red); } .heat-cell.scale { border-left-color: var(--green); } .heat-cell.warn { border-left-color: var(--amber); }
    .heat-cell b { display: block; font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
    .heat-cell span { display: block; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .alert-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .alert-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; border-top: 4px solid var(--amber); min-height: 110px; }
    .alert-card.high { border-top-color: var(--red); } .alert-card.ok { border-top-color: var(--green); }
    .alert-card b { display: block; margin-bottom: 5px; } .alert-card p { font-size: 12px; line-height: 1.4; }
    .mode-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: #eef3f8; color: #344054; margin-bottom: 14px; }
    .source-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .source-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; break-inside: avoid; }
    .source-card b { display: block; margin-bottom: 5px; }
    .source-card span { display: block; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .decision-cards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .decision-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; break-inside: avoid; }
    .decision-card b { display: block; margin-bottom: 7px; font-size: 14px; }
    .decision-card span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 760; margin-top: 9px; margin-bottom: 3px; }
    .decision-card p { font-size: 12px; line-height: 1.4; margin: 0; }
    .dataset-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; align-items: start; }
    .dataset-panel { min-height: 430px; }
    .dataset-head { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; align-items: start; margin-bottom: 8px; }
    .dataset-head h2 { margin-bottom: 0; overflow-wrap: anywhere; }
    .dataset-head span { color: var(--muted); font-size: 12px; text-align: right; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef3f8; color: #344054; font-size: 12px; text-transform: uppercase; position: sticky; top: 0; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: 0; }
    .query { margin-top: 14px; padding: 12px; border-radius: 8px; background: #101828; color: #f2f4f7; overflow: auto; font-size: 12px; line-height: 1.45; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      header, .content, .exec-grid, .analysis-grid, .dataset-grid { grid-template-columns: 1fr; }
      .meta { text-align: left; }
      .grid, .readout, .mini-cards, .dimension-grid, .heat-grid, .alert-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
    }
    @media (max-width: 560px) {
      .grid, .readout, .mini-cards, .dimension-grid, .heat-grid, .alert-grid, .source-list, .decision-cards, .waterfall { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 6px; }
      .visual-row { grid-template-columns: 1fr; }
      .visual-metric { text-align: left; }
      h1 { font-size: 24px; }
    }
    @media print {
      @page { size: A4; margin: 12mm; }
      body { background: #fff; }
      main { max-width: none; padding: 0; }
      header, .panel, .card, .insight, .heat-cell, .alert-card, .mini-card, .decision-card { break-inside: avoid; box-shadow: none; }
      .grid, .readout, .mini-cards, .heat-grid, .alert-grid, .source-list, .decision-cards { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .exec-grid, .analysis-grid, .content { grid-template-columns: 1fr; }
      .query, .print-hidden { display: none !important; }
      .panel { margin-bottom: 12px; }
      h1 { font-size: 26px; }
      h2 { font-size: 16px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <section>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(input.summary)}</p>
      </section>
      <aside class="meta">
        <div>${escapeHtml(input.workspaceName ?? "")}</div>
        <div>${escapeHtml(input.semanticModelName ?? "")}</div>
        <div>${escapeHtml(new Date(input.generatedAt).toLocaleString("en-US"))}</div>
      </aside>
    </header>

    <section class="grid">
      ${kpis.map(k => `<article class="card tone-${k.tone}"><div class="label">${escapeHtml(k.label)}</div><div class="value">${escapeHtml(k.value)}</div></article>`).join("\n      ")}
    </section>

    ${renderDataSourceSection(input)}

    ${multiDatasetMode ? renderDatasetEvidenceSection(input) : ""}

    ${multiDatasetMode ? "" : renderBusinessInsightSection(input.business)}

    ${modeSection}

    ${analysisSection}

    ${multiDatasetMode ? "" : `<section class="content">
      <article class="panel">
        <h2>${escapeHtml(chartTitle)}</h2>
        ${chartHtml || "<p>No chart data available.</p>"}
      </article>
    </section>`}

    <section class="panel print-hidden" style="margin-top:18px">
      <h2>Question</h2>
      <p>${escapeHtml(input.question ?? "")}</p>
      <pre class="query">${escapeHtml(input.query ?? "")}</pre>
    </section>
  </main>
</body>
</html>`;
}

function getChartTitle(intent: ReportIntent, analysis: any): string {
  if (!intent) return "Result Overview";
  const { mode, primaryMetric: m, primaryDimension: d, topN } = intent;
  switch (mode) {
    case "month-extremes":  return `Monthly ${m ?? "revenue"} profile`;
    case "ranking":         return `Top ${topN} ${d ?? "entries"} by ${m ?? "metric"}`;
    case "trend":           return `${m ?? "Metric"} over ${d ?? "time"}`;
    case "distribution":    return `${m ?? "Metric"} by ${d ?? "dimension"}`;
    default: return m && d ? `${m} by ${d}` : "Result Overview";
  }
}

// ═══════════════════════════════════════════════════════
// Mode: MONTH-EXTREMES  (existing executive decision block)
// ═══════════════════════════════════════════════════════

function renderMonthExtremesSection(input) {
  const { analysis } = input;
  if (!analysis) return "";
  const executive = buildExecutiveDecisionModel(input.rows, input.columns, analysis);
  const highestText = `${analysis.highest.label}: ${formatMetricValue(analysis.metric, analysis.highest.value)}`;
  const lowestText  = `${analysis.lowest.label}: ${formatMetricValue(analysis.metric, analysis.lowest.value)}`;
  return `<section class="exec-grid">
    <article class="panel">
      <div class="mode-badge">Month extremes</div>
      <h2>Executive answer</h2>
      <div class="readout">
        <div class="readout-item"><span>What happened</span><strong>${escapeHtml(highestText)} vs ${escapeHtml(lowestText)}</strong><p>Spread is ${escapeHtml(formatMetricValue(analysis.metric, analysis.spread))} across ${escapeHtml(formatNumber(input.rows.length))} monthly observations.</p></div>
        <div class="readout-item"><span>Why it happened</span><strong>${escapeHtml(volumeNarrative(executive) ? "Volume is the primary driver" : "Driver data not returned")}</strong><p>${escapeHtml(volumeNarrative(executive))}</p></div>
        <div class="readout-item"><span>So what</span><strong>${escapeHtml(executive.trendDelta >= 0 ? "Upward trajectory" : "Downward trajectory")}</strong><p>${escapeHtml(executive.trendText)}</p></div>
        <div class="readout-item"><span>Decision</span><strong>${escapeHtml(executive.trendDelta >= 0 ? "Sustain peak-month drivers" : "Diagnose trough-month gap")}</strong><p>Prioritise levers with data-backed impact before changing price or discount policy.</p></div>
      </div>
    </article>

    <article class="panel">
      <h2>Driver tree</h2>
      <div class="driver-tree">
        <div class="tree-row"><span>${escapeHtml(analysis.metric)} (total)</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.totalRevenue))}</strong></div>
        <div class="tree-row"><span>Monthly average</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.averageRevenue))}</strong></div>
        <div class="tree-row"><span>High month units</span><strong>${escapeHtml(executive.highUnits !== undefined ? formatNumber(executive.highUnits) : "Not returned")}</strong></div>
        <div class="tree-row"><span>Low month units</span><strong>${escapeHtml(executive.lowUnits  !== undefined ? formatNumber(executive.lowUnits)  : "Not returned")}</strong></div>
        <div class="tree-row"><span>Implied ASP high</span><strong>${escapeHtml(executive.highAsp  !== undefined ? formatNumber(executive.highAsp)   : "Not returned")}</strong></div>
        <div class="tree-row"><span>Implied ASP low</span><strong>${escapeHtml(executive.lowAsp   !== undefined ? formatNumber(executive.lowAsp)    : "Not returned")}</strong></div>
      </div>
    </article>

    <article class="panel">
      <h2>Revenue bridge: low → high month</h2>
      ${renderWaterfall(executive, analysis)}
    </article>

    <article class="panel">
      <h2>Decision levers</h2>
      <div class="mini-cards">
        ${executive.leverCards.map(c => `<div class="mini-card tone-${c.tone}"><span>${escapeHtml(c.label)}</span><strong>${escapeHtml(c.value)}</strong><p>${escapeHtml(c.detail)}</p></div>`).join("")}
      </div>
    </article>

    ${executive.dimensionInsights.length ? `<article class="panel">
      <h2>Cross-dimension insight scan</h2>
      <div class="dimension-grid">
        ${executive.dimensionInsights.map(i => `<div class="mini-card"><span>${escapeHtml(i.dimension)}</span><strong>${escapeHtml(i.topLabel)}: ${escapeHtml(formatMetricValue(analysis.metric, i.topValue))}</strong><p>${escapeHtml(i.read)}</p></div>`).join("")}
      </div>
    </article>` : ""}

    <article class="panel">
      <h2>Executive decision board</h2>
      ${renderDecisionCards(executive.decisionRows)}
    </article>

    <article class="panel">
      <h2>Predictive read</h2>
      <div class="driver-tree">
        <div class="tree-row"><span>Last 3-month annualised run-rate</span><strong>${escapeHtml(executive.lastThreeRunRate !== undefined ? formatMetricValue(analysis.metric, executive.lastThreeRunRate) : "Not enough rows")}</strong></div>
        <div class="tree-row"><span>Current-period total</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.totalRevenue))}</strong></div>
        <div class="tree-row"><span>Confidence</span><strong>Directional only</strong></div>
      </div>
      <p style="margin-top:10px">Forecast confidence improves when the DAX returns plan, market growth, pipeline, inventory, campaign calendar, and conversion data.</p>
    </article>
  </section>`;
}

// ═══════════════════════════════════════════════════════
// Mode: RANKING
// ═══════════════════════════════════════════════════════

function renderRankingSection(input) {
  const { rows, columns, intent } = input;
  const { primaryMetric: metric, primaryDimension: dim, topN, language } = intent;
  if (!metric || !dim) return "";
  const vi = language === "vi";

  const sorted  = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const topRows = sorted.slice(0, topN);
  const total   = rows.reduce((s, r) => s + numericValue(r[metric]), 0);
  const avg     = total / rows.length;
  const leader  = topRows[0];
  const lVal    = leader ? numericValue(leader[metric]) : 0;
  const lShare  = total  ? lVal / total : 0;
  const top3Sum = sorted.slice(0, 3).reduce((s, r) => s + numericValue(r[metric]), 0);
  const top3Share = total ? top3Sum / total : 0;
  const bottom  = sorted[sorted.length - 1];
  const bVal    = bottom ? numericValue(bottom[metric]) : 0;

  // Extra metrics (up to 2 others)
  const extraMetrics = columns
    .filter(c => c !== metric && rows.some(r => typeof r[c] === "number"))
    .slice(0, 2);

  const decisionRows = [
    {
      question: vi ? `${dim} nào dẫn đầu?` : `Which ${dim} leads?`,
      evidence: leader ? `${String(leader[dim] ?? "")} — ${formatMetricValue(metric, lVal)} (${(lShare*100).toFixed(1)}%)` : "n/a",
      decision: vi ? "Nhân rộng mô hình vận hành của đơn vị dẫn đầu" : "Replicate the operating model of the leader",
      missing:  vi ? "Root cause, chi phí, hiệu quả" : "Root cause, cost, efficiency"
    },
    {
      question: vi ? "Mức tập trung có cao không?" : "Is concentration high?",
      evidence: `Top 3: ${(top3Share*100).toFixed(1)}% ${vi ? "tổng" : "of total"}`,
      decision: vi
        ? (top3Share > 0.5 ? "Rủi ro tập trung — xem xét đa dạng hóa" : "Phân phối tương đối đều — tìm cơ hội nhân rộng")
        : (top3Share > 0.5 ? "Concentration risk — consider diversification" : "Relatively even — find scale opportunities"),
      missing:  vi ? "Dữ liệu kỳ trước để xem xu hướng" : "Prior period for trend comparison"
    },
    {
      question: vi ? `${dim} nào cần cải thiện?` : `Which ${dim} needs improvement?`,
      evidence: bottom ? `${String(bottom[dim] ?? "")} — ${formatMetricValue(metric, bVal)}` : "n/a",
      decision: vi ? "Tìm hiểu rào cản trước khi tăng đầu tư" : "Understand barriers before adding investment",
      missing:  vi ? "Nguyên nhân underperform, so sánh thị trường" : "Underperformance root cause, market comparison"
    },
    {
      question: vi ? "Cần dữ liệu gì thêm?" : "What data is still needed?",
      evidence: extraMetrics.length ? extraMetrics.join(", ") : vi ? "Chỉ có metric chính" : "Primary metric only",
      decision: vi ? `Bổ sung: target/plan, growth rate, margin, cost cho mỗi ${dim}` : `Add: target/plan, growth rate, margin, cost per ${dim}`,
      missing:  vi ? "Target, plan, margin, thị phần" : "Target, plan, market share, margin"
    }
  ];

  return `<section class="exec-grid">
    <article class="panel">
      <div class="mode-badge">Ranking</div>
      <h2>${vi ? "Phân tích xếp hạng" : "Ranking analysis"}: ${escapeHtml(metric)} ${vi ? "theo" : "by"} ${escapeHtml(dim)}</h2>
      <div class="readout">
        <div class="readout-item"><span>${vi ? "Dẫn đầu" : "Leader"}</span><strong>${escapeHtml(String(leader?.[dim] ?? ""))}</strong><p>${escapeHtml(formatMetricValue(metric, lVal))} · ${escapeHtml((lShare*100).toFixed(1))}% ${vi ? "tổng" : "of total"}</p></div>
        <div class="readout-item"><span>${vi ? "Top 3 chiếm" : "Top 3 share"}</span><strong>${escapeHtml((top3Share*100).toFixed(1))}%</strong><p>${sorted.slice(0,3).map(r => String(r[dim] ?? "")).join(", ")}</p></div>
        <div class="readout-item"><span>${vi ? "Trung bình" : "Average"}</span><strong>${escapeHtml(formatMetricValue(metric, avg))}</strong><p>${vi ? "mỗi" : "per"} ${escapeHtml(dim)}</p></div>
        <div class="readout-item"><span>${vi ? "Số lượng" : "Count"}</span><strong>${escapeHtml(formatNumber(rows.length))}</strong><p>${escapeHtml(dim)}</p></div>
      </div>
    </article>

    <article class="panel">
      <h2>${vi ? "Top" : "Top"} ${topN} ${escapeHtml(dim)} ${vi ? "theo" : "by"} ${escapeHtml(metric)}</h2>
      <div class="driver-tree">
        ${topRows.map((row, i) => {
          const v = numericValue(row[metric]);
          const sh = total ? (v/total*100).toFixed(1) : "0";
          const extras = extraMetrics.map(m2 => `${m2}: ${formatMetricValue(m2, numericValue(row[m2]))}`).join(" · ");
          return `<div class="tree-row"><span>#${i+1} ${escapeHtml(String(row[dim] ?? ""))}${extras ? " · " + escapeHtml(extras) : ""}</span><strong>${escapeHtml(formatMetricValue(metric, v))} (${escapeHtml(sh)}%)</strong></div>`;
        }).join("")}
      </div>
    </article>

    <article class="panel">
      <h2>${vi ? "Bảng quyết định" : "Decision board"}</h2>
      <div class="table-wrap"><table class="decision-table"><thead><tr><th>${vi ? "Câu hỏi" : "Question"}</th><th>${vi ? "Bằng chứng" : "Evidence"}</th><th>${vi ? "Quyết định" : "Decision"}</th><th>${vi ? "Còn thiếu" : "Still missing"}</th></tr></thead><tbody>${decisionRows.map(r => `<tr><td>${escapeHtml(r.question)}</td><td>${escapeHtml(r.evidence)}</td><td>${escapeHtml(r.decision)}</td><td>${escapeHtml(r.missing)}</td></tr>`).join("")}</tbody></table></div>
    </article>
  </section>`;
}

// ═══════════════════════════════════════════════════════
// Mode: TREND
// ═══════════════════════════════════════════════════════

function renderTrendSection(input) {
  const { rows, columns, intent } = input;
  const { primaryMetric: metric, primaryDimension: dim, language } = intent;
  if (!metric || !dim) return "";
  const vi = language === "vi";

  const sorted = [...rows].sort((a, b) => compareDimension(a[dim], b[dim]));
  const values = sorted.map(r => numericValue(r[metric]));
  const total  = values.reduce((s, v) => s + v, 0);
  const avg    = total / values.length;
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const first3avg = values.slice(0, 3).reduce((s,v)=>s+v,0) / Math.min(3, values.length);
  const last3avg  = values.slice(-3).reduce((s,v)=>s+v,0) / Math.min(3, values.length);
  const trendDelta = last3avg - first3avg;
  const trendPct   = first3avg ? (Math.abs(trendDelta / first3avg) * 100).toFixed(1) : "0";
  const runRate    = values.length >= 3 ? last3avg * 12 : undefined;
  const trendDir   = trendDelta >= 0 ? (vi ? "tăng" : "upward") : (vi ? "giảm" : "downward");

  const peakRow   = sorted.find(r => numericValue(r[metric]) === maxVal);
  const troughRow = sorted.find(r => numericValue(r[metric]) === minVal);

  const decisionRows = [
    {
      question: vi ? "Xu hướng tổng thể?" : "Overall trend?",
      evidence: `${trendDir} ${trendPct}% (${vi ? "3 kỳ cuối vs 3 kỳ đầu" : "last 3 vs first 3 periods"})`,
      decision: vi
        ? (trendDelta >= 0 ? "Duy trì momentum — xác định driver để nhân rộng" : "Điều tra nguyên nhân giảm — hành động trước khi tệ hơn")
        : (trendDelta >= 0 ? "Sustain momentum — identify driver to replicate" : "Investigate decline cause — act before further deterioration"),
      missing: vi ? "Dữ liệu plan/target, yếu tố thị trường" : "Plan/target data, market factors"
    },
    {
      question: vi ? "Kỳ nào cao nhất?" : "Which period peaked?",
      evidence: peakRow ? `${String(peakRow[dim] ?? "")} — ${formatMetricValue(metric, maxVal)}` : "n/a",
      decision: vi ? "Phân tích điều kiện đặc biệt của kỳ đỉnh để tái tạo" : "Analyse peak-period conditions to replicate",
      missing:  vi ? "Dữ liệu hoạt động (campaigns, kho, kênh)" : "Operational data (campaigns, inventory, channel)"
    },
    {
      question: vi ? "Kỳ nào thấp nhất?" : "Which period troughed?",
      evidence: troughRow ? `${String(troughRow[dim] ?? "")} — ${formatMetricValue(metric, minVal)}` : "n/a",
      decision: vi ? "Xác định nguyên nhân để tránh lặp lại" : "Identify root cause to prevent recurrence",
      missing:  vi ? "Nguyên nhân: cạnh tranh, thị trường, nội bộ" : "Cause: competition, market, internal factors"
    },
    {
      question: vi ? "Run-rate dự báo?" : "Projected run-rate?",
      evidence: runRate !== undefined ? `${vi ? "12 × TB 3 kỳ cuối" : "12 × last-3 avg"} = ${formatMetricValue(metric, runRate)}` : vi ? "Không đủ dữ liệu (cần ≥3 kỳ)" : "Insufficient data (need ≥3 periods)",
      decision: vi ? "Chỉ mang tính định hướng — cần plan/target để đánh giá" : "Directional only — need plan/target to assess",
      missing:  vi ? "Plan, target, dự báo thị trường" : "Plan, target, market forecast"
    }
  ];

  return `<section class="exec-grid">
    <article class="panel">
      <div class="mode-badge">Trend</div>
      <h2>${vi ? "Phân tích xu hướng" : "Trend analysis"}: ${escapeHtml(metric)} ${vi ? "theo" : "over"} ${escapeHtml(dim)}</h2>
      <div class="readout">
        <div class="readout-item"><span>${vi ? "Xu hướng" : "Trend"}</span><strong>${escapeHtml(trendDir)} ${escapeHtml(trendPct)}%</strong><p>${vi ? "3 kỳ cuối vs 3 kỳ đầu" : "Last 3 vs first 3 periods"}</p></div>
        <div class="readout-item"><span>${vi ? "Run-rate năm" : "Annual run-rate"}</span><strong>${escapeHtml(runRate !== undefined ? formatMetricValue(metric, runRate) : "n/a")}</strong><p>${vi ? "3 kỳ gần nhất ×12" : "Last 3 periods ×12"}</p></div>
        <div class="readout-item"><span>${vi ? "Biên độ" : "Range"}</span><strong>${escapeHtml(formatMetricValue(metric, maxVal - minVal))}</strong><p>Max ${escapeHtml(formatMetricValue(metric, maxVal))} · Min ${escapeHtml(formatMetricValue(metric, minVal))}</p></div>
        <div class="readout-item"><span>${vi ? "Trung bình kỳ" : "Period average"}</span><strong>${escapeHtml(formatMetricValue(metric, avg))}</strong><p>${rows.length} ${vi ? "kỳ" : "periods"}</p></div>
      </div>
    </article>

    <article class="panel">
      <h2>${vi ? "Bảng quyết định" : "Decision board"}</h2>
      <div class="table-wrap"><table class="decision-table"><thead><tr><th>${vi ? "Câu hỏi" : "Question"}</th><th>${vi ? "Bằng chứng" : "Evidence"}</th><th>${vi ? "Quyết định" : "Decision"}</th><th>${vi ? "Còn thiếu" : "Still missing"}</th></tr></thead><tbody>${decisionRows.map(r => `<tr><td>${escapeHtml(r.question)}</td><td>${escapeHtml(r.evidence)}</td><td>${escapeHtml(r.decision)}</td><td>${escapeHtml(r.missing)}</td></tr>`).join("")}</tbody></table></div>
    </article>
  </section>`;
}

// ═══════════════════════════════════════════════════════
// Mode: DISTRIBUTION
// ═══════════════════════════════════════════════════════

function renderDistributionSection(input) {
  const { rows, columns, intent } = input;
  const { primaryMetric: metric, primaryDimension: dim, language } = intent;
  if (!metric || !dim) return "";
  const vi = language === "vi";

  const total  = rows.reduce((s, r) => s + numericValue(r[metric]), 0);
  const sorted = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]));
  const top3   = sorted.slice(0, 3);
  const top3Sum = top3.reduce((s, r) => s + numericValue(r[metric]), 0);
  const top3Share = total ? top3Sum / total : 0;

  // Herfindahl index (market concentration)
  const hhi = rows.reduce((s, r) => {
    const sh = total ? numericValue(r[metric]) / total : 0;
    return s + sh * sh;
  }, 0);
  const concentration = hhi > 0.25
    ? (vi ? "Tập trung cao" : "High concentration")
    : hhi > 0.1
    ? (vi ? "Tập trung vừa" : "Moderate concentration")
    : (vi ? "Phân tán" : "Dispersed");

  const otherDims = columns
    .filter(c => c !== dim && c !== "Scope" && c !== "Dimension" && c !== "Member" && rows.some(r => typeof r[c] === "string"))
    .slice(0, 2);

  const decisionRows = [
    {
      question: vi ? `${dim} nào quan trọng nhất?` : `Which ${dim} matters most?`,
      evidence: top3.map(r => `${String(r[dim] ?? "")} (${(numericValue(r[metric])/total*100).toFixed(1)}%)`).join(", "),
      decision: vi ? "Tập trung nguồn lực vào top đóng góp cao" : "Allocate resources toward top contributors",
      missing:  vi ? "Margin, ROI, chiến lược phân bổ" : "Margin, ROI, allocation strategy"
    },
    {
      question: vi ? "Mức tập trung có ổn không?" : "Is concentration healthy?",
      evidence: `HHI ${hhi.toFixed(3)} → ${concentration}`,
      decision: vi
        ? (top3Share > 0.7 ? "Quá tập trung — đa dạng hoá hoặc đầu tư vào nhóm nhỏ hơn" : "Phân bổ hợp lý — giữ ổn định và tối ưu")
        : (top3Share > 0.7 ? "Overly concentrated — diversify or invest in smaller groups" : "Healthy spread — maintain and optimise"),
      missing:  vi ? "Dữ liệu cạnh tranh và phân bổ chi phí" : "Competitive data and cost allocation"
    },
    {
      question: vi ? `${dim} nào underperform?` : `Which ${dim} underperforms?`,
      evidence: sorted.slice(-3).map(r => `${String(r[dim] ?? "")} (${formatMetricValue(metric, numericValue(r[metric]))})`).join(", "),
      decision: vi ? "Điều tra rào cản trước khi cắt nguồn lực" : "Investigate barriers before cutting resources",
      missing:  vi ? "Root cause, điều kiện thị trường, chiến lược" : "Root cause, market conditions, strategy"
    },
    {
      question: vi ? "Chiều phân tích nào còn thiếu?" : "Which dimensions are missing?",
      evidence: otherDims.length ? otherDims.join(", ") : vi ? "Chỉ một chiều" : "Single dimension only",
      decision: vi ? `Kết hợp thêm chiều: ${otherDims.join(", ") || "không có"}` : `Cross-tabulate with: ${otherDims.join(", ") || "none available"}`,
      missing:  vi ? "Time series, margin per group, plan vs actual" : "Time series, margin per group, plan vs actual"
    }
  ];

  return `<section class="exec-grid">
    <article class="panel">
      <div class="mode-badge">Distribution</div>
      <h2>${vi ? "Phân tích phân bố" : "Distribution analysis"}: ${escapeHtml(metric)} ${vi ? "theo" : "by"} ${escapeHtml(dim)}</h2>
      <div class="readout">
        <div class="readout-item"><span>${vi ? "Top 3 chiếm" : "Top 3 share"}</span><strong>${escapeHtml((top3Share*100).toFixed(1))}%</strong><p>${top3.map(r => String(r[dim]??"")+` (${(numericValue(r[metric])/total*100).toFixed(1)}%)`).join(", ")}</p></div>
        <div class="readout-item"><span>${vi ? "Độ tập trung" : "Concentration"}</span><strong>${escapeHtml(concentration)}</strong><p>HHI ${escapeHtml(hhi.toFixed(3))}</p></div>
        <div class="readout-item"><span>${vi ? "Tổng" : "Total"} ${escapeHtml(metric)}</span><strong>${escapeHtml(formatMetricValue(metric, total))}</strong><p>${rows.length} ${escapeHtml(dim)}</p></div>
        <div class="readout-item"><span>${vi ? "Số chiều" : "Dimensions"}</span><strong>${escapeHtml(String(columns.filter(c => rows.some(r => typeof r[c] === "string")).length))}</strong><p>${vi ? "cột phân loại" : "category columns"}</p></div>
      </div>
    </article>

    <article class="panel">
      <h2>${vi ? "Bảng quyết định" : "Decision board"}</h2>
      <div class="table-wrap"><table class="decision-table"><thead><tr><th>${vi ? "Câu hỏi" : "Question"}</th><th>${vi ? "Bằng chứng" : "Evidence"}</th><th>${vi ? "Quyết định" : "Decision"}</th><th>${vi ? "Còn thiếu" : "Still missing"}</th></tr></thead><tbody>${decisionRows.map(r => `<tr><td>${escapeHtml(r.question)}</td><td>${escapeHtml(r.evidence)}</td><td>${escapeHtml(r.decision)}</td><td>${escapeHtml(r.missing)}</td></tr>`).join("")}</tbody></table></div>
    </article>
  </section>`;
}

// ═══════════════════════════════════════════════════════
// Chart helpers (mode-specific)
// ═══════════════════════════════════════════════════════

function renderRankedBars(rows: any[], dim: string, metric: string, topN: number): string {
  if (!dim || !metric || !rows.length) return "<p>No chart data.</p>";
  const sorted = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric])).slice(0, topN);
  const max = Math.max(...sorted.map(r => Math.abs(numericValue(r[metric]))), 1);
  return `<div class="bars">${sorted.map((r, i) => {
    const v = numericValue(r[metric]);
    const lbl = String(r[dim] ?? "");
    return `<div class="bar-row"><div class="bar-label" title="${escapeHtml(lbl)}">#${i+1} ${escapeHtml(lbl)}</div><div class="track"><div class="fill" style="width:${Math.max(3, Math.round(Math.abs(v)/max*100))}%"></div></div><div class="bar-value">${escapeHtml(formatMetricValue(metric, v))}</div></div>`;
  }).join("")}</div>`;
}

function renderTrendBars(rows: any[], dim: string, metric: string): string {
  if (!dim || !metric || !rows.length) return "<p>No chart data.</p>";
  const sorted = [...rows].sort((a, b) => compareDimension(a[dim], b[dim]));
  const values = sorted.map(r => numericValue(r[metric]));
  const avg    = values.reduce((s, v) => s + v, 0) / values.length;
  const max    = Math.max(...values.map(Math.abs), 1);
  return `<div class="monthly-bars">${sorted.map(r => {
    const v = numericValue(r[metric]);
    const above = v >= avg;
    return `<div class="bar-row"><div class="bar-label">${escapeHtml(String(r[dim] ?? ""))}</div><div class="track"><div class="fill${above ? "" : " down"}" style="width:${Math.max(3, Math.round(Math.abs(v)/max*100))}%"></div></div><div class="bar-value">${escapeHtml(formatMetricValue(metric, v))}</div></div>`;
  }).join("")}</div>`;
}

function renderDistributionBars(rows: any[], dim: string, metric: string): string {
  return renderGenericBars(rows, dim, metric, 20);
}

function renderGenericBars(rows: any[], dim: string, metric: string, limit = 15): string {
  if (!dim || !metric || !rows.length) return "<p>No chart data.</p>";
  const sorted = [...rows].sort((a, b) => numericValue(b[metric]) - numericValue(a[metric])).slice(0, limit);
  const max = Math.max(...sorted.map(r => Math.abs(numericValue(r[metric]))), 1);
  return `<div class="bars">${sorted.map(r => {
    const v   = numericValue(r[metric]);
    const lbl = String(r[dim] ?? "");
    return `<div class="bar-row"><div class="bar-label" title="${escapeHtml(lbl)}">${escapeHtml(lbl)}</div><div class="track"><div class="fill" style="width:${Math.max(3, Math.round(Math.abs(v)/max*100))}%"></div></div><div class="bar-value">${escapeHtml(formatMetricValue(metric, v))}</div></div>`;
  }).join("")}</div>`;
}

// ═══════════════════════════════════════════════════════
// Month-extremes helpers (kept from original)
// ═══════════════════════════════════════════════════════

function renderWaterfall(executive, analysis) {
  const unitEffect   = executive.unitEffect   ?? 0;
  const aspMixEffect = executive.aspMixEffect ?? 0;
  const max = Math.max(Math.abs(analysis.lowest.value), Math.abs(unitEffect), Math.abs(aspMixEffect), Math.abs(analysis.highest.value), 1);
  const step = (label, value, tone) =>
    `<div class="wf-step ${tone}"><span>${escapeHtml(label)}</span><i style="height:${Math.max(6, Math.round(Math.abs(value)/max*100))}%"></i><b>${escapeHtml(formatMetricValue(analysis.metric, value))}</b></div>`;
  return `<div class="waterfall">
    ${step(`Low month ${analysis.lowest.label}`,   analysis.lowest.value,   "bad")}
    ${step("Unit effect",   unitEffect,   unitEffect   >= 0 ? "good" : "bad")}
    ${step("ASP / mix",     aspMixEffect, aspMixEffect >= 0 ? "warn" : "bad")}
    ${step(`High month ${analysis.highest.label}`, analysis.highest.value, "good")}
  </div>`;
}

function renderMonthlyBars(rows, dimension, metric) {
  const sorted = [...selectMonthlyRows(rows)].sort((a, b) => compareDimension(a[dimension], b[dimension]));
  const max = Math.max(...sorted.map(r => Math.abs(numericValue(r[metric]))), 1);
  return `<div class="monthly-bars">${sorted.map(r => {
    const v = numericValue(r[metric]);
    return `<div class="bar-row"><div class="bar-label">Month ${escapeHtml(String(r[dimension] ?? ""))}</div><div class="track"><div class="fill" style="width:${Math.max(3, Math.round(Math.abs(v)/max*100))}%"></div></div><div class="bar-value">${escapeHtml(formatMetricValue(metric, v))}</div></div>`;
  }).join("")}</div>`;
}

function renderAnalysisTables(rows, analysis) {
  const tables = buildAnalysisTables(rows, analysis);
  if (!tables.length) return "";
  return `<section class="analysis-stack">
    <article class="panel">
      <h2>Business insight dashboard</h2>
      <p class="analysis-note">Visual analysis blocks derived from returned rows. Raw rows are available in MCP structuredContent for auditability.</p>
    </article>
    <section class="analysis-grid">
      ${tables.map(t => `<article class="panel"><h2>${escapeHtml(t.title)}</h2><p class="analysis-note">${escapeHtml(t.subtitle)}</p>${renderAnalysisVisual(t)}</article>`).join("")}
    </section>
  </section>`;
}

function buildAnalysisTables(rows, analysis) {
  return [
    buildMonthlyPerformanceTable(rows, analysis),
    ...buildContributionTables(rows, analysis),
    ...buildCrossContributionTables(rows, analysis),
    buildRiskWatchTable(rows, analysis)
  ].filter(t => t !== undefined);
}

function buildMonthlyPerformanceTable(rows, analysis) {
  const monthlyRows = selectMonthlyRows(rows);
  if (!monthlyRows.length) return undefined;
  const unitsCol = findColumnByTokens(Object.keys(monthlyRows[0] ?? {}), ["unit","quantity","sold"]);
  const aspCol   = findColumnByTokens(Object.keys(monthlyRows[0] ?? {}), ["asp","weightedasp"]);
  const avgRev   = average(monthlyRows.map(r => numericValue(r[analysis.metric])));
  const sorted   = [...monthlyRows].sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric])).slice(0, 6);
  return {
    title: "Monthly performance ranking",
    subtitle: "Ranks months and shows whether the gap is volume-led or price/mix-led.",
    columns: ["Month","Revenue","Units","ASP","Vs Avg","CEO read"],
    rows: sorted.map(r => {
      const rev  = numericValue(r[analysis.metric]);
      const units = unitsCol ? numericValue(r[unitsCol]) : 0;
      const asp   = aspCol   ? numericValue(r[aspCol])   : impliedAsp(rev, units);
      return {
        Month:    String(r[analysis.dimension] ?? ""),
        Revenue:  formatMetricValue(analysis.metric, rev),
        Units:    unitsCol ? formatNumber(units) : "n/a",
        ASP:      asp !== undefined ? `${formatNumber(asp)} triệu VND` : "n/a",
        "Vs Avg": formatMetricValue(analysis.metric, rev - avgRev),
        "CEO read": rev >= avgRev ? "Scale playbook" : "Recovery watch"
      };
    })
  };
}

function buildContributionTables(rows, analysis) {
  if (!(Object.keys(rows[0] ?? {}).includes("Dimension") && Object.keys(rows[0] ?? {}).includes("Member"))) return [];
  const monthlyTotal = selectMonthlyRows(rows).reduce((s, r) => s + numericValue(r[analysis.metric]), 0);
  const dimensions   = unique(rows.filter(r => String(r.Scope ?? "") === "Dimension").map(r => String(r.Dimension ?? "")).filter(Boolean));
  return dimensions.map(dim => {
    const grouped = rows.filter(r => String(r.Scope ?? "") === "Dimension" && String(r.Dimension ?? "") === dim)
      .sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric])).slice(0, 8);
    return {
      title: `${dim} contribution`,
      subtitle: `Contribution ranking by ${dim}.`,
      columns: [dim,"Revenue","Share","Units","Margin","Business read"],
      rows: grouped.map(r => {
        const rev    = numericValue(r[analysis.metric]);
        const margin = findColumnByTokens(Object.keys(r), ["margin"]);
        const units  = findColumnByTokens(Object.keys(r), ["unit","quantity","sold"]);
        return {
          [dim]:           String(r.Member ?? ""),
          Revenue:         formatMetricValue(analysis.metric, rev),
          Share:           monthlyTotal ? formatPercent(rev/monthlyTotal) : "n/a",
          Units:           units  ? formatNumber(numericValue(r[units]))  : "n/a",
          Margin:          margin ? formatMetricValue(margin, numericValue(r[margin])) : "n/a",
          "Business read": contributionRead(rev, monthlyTotal)
        };
      })
    };
  });
}

function buildCrossContributionTables(rows, analysis) {
  if (!(Object.keys(rows[0] ?? {}).includes("Dimension") && Object.keys(rows[0] ?? {}).includes("Member"))) return [];
  const monthlyTotal   = selectMonthlyRows(rows).reduce((s, r) => s + numericValue(r[analysis.metric]), 0);
  const crossDimensions = unique(rows.filter(r => String(r.Scope ?? "") === "Cross").map(r => String(r.Dimension ?? "")).filter(Boolean));
  return crossDimensions.map(dim => {
    const grouped = rows.filter(r => String(r.Scope ?? "") === "Cross" && String(r.Dimension ?? "") === dim)
      .sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric])).slice(0, 10);
    return {
      title: `${dim} pockets`,
      subtitle: "Cross-dimension pockets where CEO insight lives.",
      columns: ["Pocket","Revenue","Share","Units","Margin","Action cue"],
      rows: grouped.map(r => {
        const rev    = numericValue(r[analysis.metric]);
        const margin = findColumnByTokens(Object.keys(r), ["margin"]);
        const units  = findColumnByTokens(Object.keys(r), ["unit","quantity","sold"]);
        return {
          Pocket:        String(r.Member ?? ""),
          Revenue:       formatMetricValue(analysis.metric, rev),
          Share:         monthlyTotal ? formatPercent(rev/monthlyTotal) : "n/a",
          Units:         units  ? formatNumber(numericValue(r[units])) : "n/a",
          Margin:        margin ? formatMetricValue(margin, numericValue(r[margin])) : "n/a",
          "Action cue":  crossActionCue(r, analysis.metric)
        };
      })
    };
  });
}

function buildRiskWatchTable(rows, analysis) {
  const candidates = rows.filter(r => String(r.Scope ?? "") !== "Monthly");
  if (!candidates.length) return undefined;
  const invCol  = findColumnByTokens(Object.keys(candidates[0] ?? {}), ["inventory"]);
  const discCol = findColumnByTokens(Object.keys(candidates[0] ?? {}), ["discount"]);
  const mktCol  = findColumnByTokens(Object.keys(candidates[0] ?? {}), ["marketing"]);
  const msCol   = findColumnByTokens(Object.keys(candidates[0] ?? {}), ["marketshare"]);
  const scored  = candidates.map(r => {
    const score = (invCol ? numericValue(r[invCol]) : 0)
      + (discCol ? numericValue(r[discCol]) / 10 : 0)
      + (mktCol  ? numericValue(r[mktCol])  / 10 : 0)
      - (msCol   ? numericValue(r[msCol])        : 0);
    return { r, score };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
  if (!scored.length) return undefined;
  return {
    title: "Risk and anomaly watch",
    subtitle: "First-pass watchlist based on returned operational drivers.",
    columns: ["Slice","Revenue","Inventory","Discount","Marketing","Risk read"],
    rows: scored.map(({ r }) => ({
      Slice:      [r.Dimension, r.Member].filter(Boolean).join(": "),
      Revenue:    formatMetricValue(analysis.metric, numericValue(r[analysis.metric])),
      Inventory:  invCol  ? formatNumber(numericValue(r[invCol]))  : "n/a",
      Discount:   discCol ? formatMetricValue(analysis.metric, numericValue(r[discCol])) : "n/a",
      Marketing:  mktCol  ? formatMetricValue(analysis.metric, numericValue(r[mktCol]))  : "n/a",
      "Risk read": riskRead(r, invCol, discCol, mktCol, msCol)
    }))
  };
}

function renderAnalysisVisual(table) {
  if (table.title.includes("Monthly performance")) return renderMonthlyPerformanceVisual(table);
  if (table.title.includes("pockets"))             return renderPocketVisual(table);
  if (table.title.includes("Risk"))                return renderRiskVisual(table);
  if (table.title.includes("contribution"))        return renderContributionVisual(table);
  return renderStringTable(table.columns, table.rows);
}

function renderMonthlyPerformanceVisual(table) {
  const max = maxFromRows(table.rows, "Revenue");
  return `<div class="visual-grid">${table.rows.map(r => {
    const v = parseFormattedNumber(r.Revenue);
    const w = max ? Math.max(4, Math.round(v/max*100)) : 4;
    return `<div class="visual-row"><div class="visual-name">Month ${escapeHtml(r.Month)}<span class="visual-sub">${escapeHtml(r["CEO read"])} · ${escapeHtml(r["Vs Avg"])}</span></div><div class="track"><div class="fill" style="width:${w}%"></div></div><div class="visual-metric">${escapeHtml(r.Revenue)}<span class="visual-sub">${escapeHtml(r.Units)} units · ASP ${escapeHtml(r.ASP)}</span></div></div>`;
  }).join("")}</div>`;
}

function renderContributionVisual(table) {
  const dimension = table.columns[0];
  const max = maxFromRows(table.rows, "Revenue");
  return `<div class="visual-grid">${table.rows.slice(0, 8).map(r => {
    const v = parseFormattedNumber(r.Revenue);
    const w = max ? Math.max(4, Math.round(v/max*100)) : 4;
    return `<div class="visual-row"><div class="visual-name">${escapeHtml(r[dimension])}<span class="visual-sub">${escapeHtml(r["Business read"])} · Margin ${escapeHtml(r.Margin)}</span></div><div class="track"><div class="fill" style="width:${w}%"></div></div><div class="visual-metric">${escapeHtml(r.Share)}<span class="visual-sub">${escapeHtml(r.Revenue)} · ${escapeHtml(r.Units)} units</span></div></div>`;
  }).join("")}</div>`;
}

function renderPocketVisual(table) {
  return `<div class="heat-grid">${table.rows.slice(0, 8).map(r => {
    const cue = r["Action cue"] ?? "";
    const tone = cue.includes("Fix") ? "risk" : cue.includes("Audit") ? "warn" : "scale";
    return `<div class="heat-cell ${tone}"><b>${escapeHtml(r.Pocket)}</b><span>${escapeHtml(r.Revenue)} · ${escapeHtml(r.Share)} share · ${escapeHtml(r.Units)} units</span><span>Margin ${escapeHtml(r.Margin)} · ${escapeHtml(cue)}</span></div>`;
  }).join("")}</div>`;
}

function renderRiskVisual(table) {
  return `<div class="alert-grid">${table.rows.slice(0, 8).map(r => {
    const read = r["Risk read"] ?? "";
    const tone = read.includes("heavy") || read.includes("weak") ? "high" : read.includes("monitor") ? "" : "ok";
    return `<div class="alert-card ${tone}"><b>${escapeHtml(r.Slice)}</b><p>${escapeHtml(read)}</p><p>${escapeHtml(r.Revenue)} · Inventory ${escapeHtml(r.Inventory)} · Discount ${escapeHtml(r.Discount)}</p></div>`;
  }).join("")}</div>`;
}

function renderStringTable(columns, rows) {
  if (!rows.length) return "<p>No analysis rows.</p>";
  return `<div class="table-wrap"><table><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${escapeHtml(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// ═══════════════════════════════════════════════════════
// Month-extremes analysis (kept intact)
// ═══════════════════════════════════════════════════════

function analyzeRevenueMonthExtremes(question, rows, columns) {
  if (rows.length === 0) return undefined;
  const monthColumn   = findMonthColumn(rows, columns);
  const revenueColumn = findRevenueColumn(rows, columns);
  if (!revenueColumn && !asksForMonthExtremes(question)) return undefined;
  const metricColumn  = revenueColumn ?? firstNumericColumn(rows, columns);
  if (!monthColumn || !metricColumn) return undefined;
  const totals = new Map();
  for (const row of rows) {
    const label = String(row[monthColumn] ?? "").trim();
    if (!label) continue;
    totals.set(label, (totals.get(label) ?? 0) + numericValue(row[metricColumn]));
  }
  if (totals.size < 2) return undefined;
  const ranked  = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const highest = ranked[0];
  const lowest  = ranked[ranked.length - 1];
  const language = prefersVietnamese(question) ? "vi" : "en";
  return {
    dimension: monthColumn,
    metric:    metricColumn,
    highest: {
      label:   highest[0],
      value:   highest[1],
      reasons: explainExtreme("high", highest[0], rows, columns, monthColumn, metricColumn, totals, language)
    },
    lowest: {
      label:   lowest[0],
      value:   lowest[1],
      reasons: explainExtreme("low",  lowest[0],  rows, columns, monthColumn, metricColumn, totals, language)
    },
    spread:   highest[1] - lowest[1],
    language
  };
}

function explainExtreme(mode, monthLabel, rows, columns, monthColumn, metricColumn, monthTotals, language) {
  const reasons    = [];
  const monthRows  = rows.filter(r => String(r[monthColumn] ?? "").trim() === monthLabel);
  const monthAvg   = average([...monthTotals.values()]);
  const monthValue = monthTotals.get(monthLabel) ?? 0;
  const variance   = monthValue - monthAvg;
  const driver     = strongestNumericDriver(mode, monthRows, rows, columns, monthColumn, metricColumn);
  if (driver) {
    reasons.push(language === "vi"
      ? `${driver.column} ${mode === "high" ? "cao hơn" : "thấp hơn"} mức trung bình (${formatNumber(driver.value)} so với ${formatNumber(driver.average)}), là driver nổi bật nhất trong các cột query trả về.`
      : `${driver.column} is ${mode === "high" ? "above" : "below"} average (${formatNumber(driver.value)} vs ${formatNumber(driver.average)}), the strongest returned driver.`);
  }
  const contributor = strongestDimensionContributor(mode, monthLabel, rows, columns, monthColumn, metricColumn);
  if (contributor) {
    reasons.push(language === "vi"
      ? `${contributor.column} = ${contributor.value} đóng góp ${formatNumber(contributor.amount)} trong tháng này và lệch ${formatNumber(contributor.delta)} so với mức tháng trung bình của cùng nhóm.`
      : `${contributor.column} = ${contributor.value} contributed ${formatNumber(contributor.amount)} this month, ${formatNumber(contributor.delta)} from that group's monthly average.`);
  }
  if (reasons.length === 0) {
    reasons.push(language === "vi"
      ? `Query hiện chỉ đủ dữ liệu để xác nhận tháng này ${mode === "high" ? "cao hơn" : "thấp hơn"} mức trung bình ${formatNumber(Math.abs(variance))}; để giải thích sâu hơn, hãy trả thêm các driver như số đơn, khách hàng, sản phẩm, khu vực hoặc kênh bán.`
      : `Only enough data to confirm this month is ${formatNumber(Math.abs(variance))} ${mode === "high" ? "above" : "below"} average; return drivers such as orders, customers, product, region, or channel for a deeper explanation.`);
  }
  return reasons;
}

function strongestNumericDriver(mode, monthRows, allRows, columns, monthColumn, metricColumn) {
  const candidates = columns.filter(c => c !== monthColumn && c !== metricColumn && allRows.some(r => typeof r[c] === "number"));
  return candidates.map(c => {
    const value    = sumRows(monthRows, c);
    const avgValue = averageByMonth(allRows, monthColumn, c);
    return { column: c, value, average: avgValue, delta: value - avgValue };
  }).filter(i => mode === "high" ? i.delta > 0 : i.delta < 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}

function strongestDimensionContributor(mode, monthLabel, rows, columns, monthColumn, metricColumn) {
  const dimCols = columns.filter(c => c !== monthColumn && !["Scope","Dimension","Member"].includes(c) && rows.some(r => typeof r[c] === "string"));
  const candidates = dimCols.flatMap(c => {
    const values = unique(rows.map(r => String(r[c] ?? "").trim()).filter(Boolean));
    return values.map(v => {
      const amount    = rows.filter(r => String(r[monthColumn] ?? "").trim() === monthLabel && String(r[c] ?? "").trim() === v).reduce((s, r) => s + numericValue(r[metricColumn]), 0);
      const avgAmount = averageContributionByMonth(rows, monthColumn, c, v, metricColumn);
      return { column: c, value: v, amount, delta: amount - avgAmount };
    });
  });
  return candidates
    .filter(i => i.amount !== 0 && (mode === "high" ? i.delta > 0 : i.delta < 0))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}

function buildExecutiveDecisionModel(rows, columns, analysis) {
  const monthlyRows   = selectMonthlyRows(rows);
  const unitsCol      = findColumnByTokens(columns, ["unit","quantity","vehicle","sold"]);
  const aspCol        = findColumnByTokens(columns, ["asp","averagesellingprice","weightedasp"]);
  const discountCol   = findColumnByTokens(columns, ["discount"]);
  const marketingCol  = findColumnByTokens(columns, ["marketing","promotion"]);
  const marginCol     = findColumnByTokens(columns, ["margin"]);
  const inventoryCol  = findColumnByTokens(columns, ["inventory"]);
  const marketShareCol= findColumnByTokens(columns, ["marketshare"]);
  const highRow = aggregateRows(monthlyRows.filter(r => String(r[analysis.dimension] ?? "").trim() === analysis.highest.label), columns);
  const lowRow  = aggregateRows(monthlyRows.filter(r => String(r[analysis.dimension] ?? "").trim() === analysis.lowest.label),  columns);
  const totalRevenue   = monthlyRows.reduce((s, r) => s + numericValue(r[analysis.metric]), 0);
  const averageRevenue = totalRevenue / Math.max(monthlyRows.length, 1);
  const highUnits = unitsCol ? numericValue(highRow[unitsCol]) : undefined;
  const lowUnits  = unitsCol ? numericValue(lowRow[unitsCol])  : undefined;
  const highAsp   = impliedAsp(analysis.highest.value, highUnits, aspCol ? numericValue(highRow[aspCol]) : undefined);
  const lowAsp    = impliedAsp(analysis.lowest.value,  lowUnits,  aspCol ? numericValue(lowRow[aspCol])  : undefined);
  const unitEffect   = highUnits !== undefined && lowUnits !== undefined && lowAsp !== undefined ? ((highUnits - lowUnits) * lowAsp) / 1000 : undefined;
  const aspMixEffect = highUnits !== undefined && highAsp  !== undefined && lowAsp !== undefined ? (highUnits * (highAsp - lowAsp)) / 1000   : undefined;
  const sorted        = [...monthlyRows].sort((a, b) => compareDimension(a[analysis.dimension], b[analysis.dimension]));
  const lastThree     = sorted.slice(-3);
  const firstThree    = sorted.slice(0,  3);
  const lastThreeAvg  = average(lastThree.map(r => numericValue(r[analysis.metric])));
  const firstThreeAvg = average(firstThree.map(r => numericValue(r[analysis.metric])));
  const lastThreeRunRate = lastThree.length >= 3 ? lastThreeAvg * 12 : undefined;
  const trendDelta = lastThreeAvg - firstThreeAvg;
  const trendText  = trendDelta >= 0
    ? `Last 3-month average is ${formatMetricValue(analysis.metric, Math.abs(trendDelta))} above the first 3-month average.`
    : `Last 3-month average is ${formatMetricValue(analysis.metric, Math.abs(trendDelta))} below the first 3-month average.`;
  const leverCards = [
    { label: "Volume sensitivity",  value: formatMetricValue(analysis.metric, totalRevenue * 0.05), detail: "Approximate revenue lift from +5% units at current economics.", tone: "green" },
    { label: "Price / mix sensitivity", value: formatMetricValue(analysis.metric, totalRevenue * 0.01), detail: "Approximate revenue lift from +1% ASP/mix with units unchanged.", tone: "blue" },
    { label: "Discount pool",  value: discountCol  ? formatMetricValue(analysis.metric, sumRows(rows, discountCol))  : "Not returned", detail: "Use as a margin-leakage control.", tone: "amber" },
    { label: "Marketing spend", value: marketingCol ? formatMetricValue(analysis.metric, sumRows(rows, marketingCol)) : "Not returned", detail: "Decision quality improves when linked to conversion or campaign ROI.", tone: "red" }
  ];
  const monthAvgUnits = averageByMonth(monthlyRows, analysis.dimension, unitsCol ?? analysis.metric);
  const decisionRows = [
    {
      question: "Why is the peak month strong?",
      evidence: highUnits !== undefined ? `${analysis.highest.label} sold ${formatNumber(highUnits)} units, vs ${formatNumber(monthAvgUnits)} monthly average.` : `${analysis.highest.label} is the highest ${analysis.metric} month.`,
      decision: "Replicate the peak-month demand and channel operating pattern before scaling spend.",
      missing:  "Dealer capacity, traffic, conversion, campaign calendar."
    },
    {
      question: "Why is the trough month weak?",
      evidence: lowUnits !== undefined ? `${analysis.lowest.label} sold ${formatNumber(lowUnits)} units, vs ${formatNumber(monthAvgUnits)} monthly average.` : `${analysis.lowest.label} is the lowest ${analysis.metric} month.`,
      decision: "Treat the trough as a volume recovery issue unless ASP/mix deterioration is proven.",
      missing:  "Lost leads, stock-outs, competitor actions, financing approval rates."
    },
    {
      question: "Is price the main issue?",
      evidence: highAsp !== undefined && lowAsp !== undefined ? `Implied ASP changes from ${formatNumber(lowAsp)} to ${formatNumber(highAsp)}.` : "ASP was not returned.",
      decision: "Do not lead with price changes if volume explains most of the variance.",
      missing:  "Model mix, trim mix, discount by dealer, transaction-level price waterfall."
    },
    {
      question: "What should CEO monitor next?",
      evidence: `${marginCol ? "Margin returned. " : "Margin missing. "}${inventoryCol ? "Inventory returned. " : "Inventory missing. "}${marketShareCol ? "Market share returned." : "Market share missing."}`,
      decision: "Add a standing weekly view for volume, ASP/mix, discount, inventory days, market share, and marketing ROI.",
      missing:  "Plan/forecast/target and cash conversion metrics."
    }
  ];
  return {
    totalRevenue, averageRevenue, highRow, lowRow, highUnits, lowUnits, highAsp, lowAsp,
    unitEffect, aspMixEffect, lastThreeRunRate, trendText, trendDelta, leverCards, decisionRows,
    dimensionInsights: buildDimensionInsights(rows, columns, analysis)
  };
}

function buildDimensionInsights(rows, columns, analysis) {
  if (columns.includes("Dimension") && columns.includes("Member")) {
    const total = selectMonthlyRows(rows).reduce((s, r) => s + numericValue(r[analysis.metric]), 0);
    return unique(rows.filter(r => String(r.Scope ?? "") !== "Monthly" && typeof r.Dimension === "string").map(r => String(r.Dimension)))
      .map(dim => {
        const dimRows = rows.filter(r => String(r.Dimension ?? "") === dim && String(r.Scope ?? "") !== "Monthly");
        const grouped = groupMetric(dimRows, "Member", analysis.metric).filter(i => i.label && i.value > 0).sort((a,b) => b.value - a.value);
        if (grouped.length < 2) return undefined;
        const top = grouped[0], bot = grouped[grouped.length - 1];
        const topShare = total ? top.value / total : 0;
        return { dimension: dim, topLabel: top.label, topValue: top.value, topShare, bottomLabel: bot.label, bottomValue: bot.value, itemCount: grouped.length, read: `${top.label} leads ${dim} with ${formatPercent(topShare)} of revenue; ${bot.label} is the smallest returned contributor.` };
      }).filter(i => i !== undefined).slice(0, 6);
  }
  const dims  = columns.filter(c => c !== analysis.dimension && c !== "Scope" && rows.some(r => typeof r[c] === "string"));
  const total = rows.reduce((s, r) => s + numericValue(r[analysis.metric]), 0);
  return dims.map(dim => {
    const grouped = groupMetric(rows, dim, analysis.metric).filter(i => i.label && i.value > 0).sort((a,b) => b.value - a.value);
    if (grouped.length < 2) return undefined;
    const top = grouped[0], bot = grouped[grouped.length - 1];
    const topShare = total ? top.value / total : 0;
    return { dimension: dim, topLabel: top.label, topValue: top.value, topShare, bottomLabel: bot.label, bottomValue: bot.value, itemCount: grouped.length, read: `${top.label} leads ${dim} with ${formatPercent(topShare)} of returned revenue; ${bot.label} is the smallest contributor.` };
  }).filter(i => i !== undefined).slice(0, 6);
}

// ═══════════════════════════════════════════════════════
// Data normalisation (unchanged)
// ═══════════════════════════════════════════════════════

function normalizeDaxResult(result) {
  const candidates = collectRowCandidates(result);
  const rows = candidates.map(r => normalizeRow(r)).filter(r => r !== undefined);
  const columns = unique(rows.flatMap(r => Object.keys(r)));
  return { rows, columns };
}

function collectRowCandidates(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.rows)) return mapRowsWithColumns(value.rows, value.columns);
  const firstTable = firstArrayTable(value.tables) || firstArrayTable(value.results);
  if (firstTable) {
    if (Array.isArray(firstTable.rows)) return mapRowsWithColumns(firstTable.rows, firstTable.columns);
    if (Array.isArray(firstTable.data)) return firstTable.data;
  }
  if (isRecord(value.result)) return collectRowCandidates(value.result);
  if (isRecord(value.data))   return collectRowCandidates(value.data);
  return [value];
}

function firstArrayTable(value) {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.rows) || Array.isArray(item.data)) return item;
    const nested = firstArrayTable(item.tables);
    if (nested) return nested;
  }
  return undefined;
}

function mapRowsWithColumns(rows, columns) {
  if (!Array.isArray(columns)) return rows;
  const names = columns.map((c, i) => isRecord(c) ? String(c.name ?? c.columnName ?? c.caption ?? `Column ${i+1}`) : String(c || `Column ${i+1}`));
  return rows.map(r => Array.isArray(r) ? Object.fromEntries(r.map((v, i) => [names[i] || `Column ${i+1}`, v])) : r);
}

function normalizeRow(value) {
  if (!isRecord(value)) return undefined;
  const row = {};
  for (const [k, v] of Object.entries(value)) {
    if (isPrimitive(v)) row[cleanColumnName(k)] = v;
  }
  return Object.keys(row).length ? row : undefined;
}

// ═══════════════════════════════════════════════════════
// Column finders
// ═══════════════════════════════════════════════════════

function findMonthColumn(rows, columns) {
  const byName = columns.find(c => {
    const n = normalizeForMatch(c);
    return ["yearmonth","month","period","date","thang","ngay"].some(t => n.includes(t));
  });
  if (byName) return byName;
  return columns.find(c => rows.some(r => { const v = r[c]; return typeof v === "string" && looksLikeMonthValue(v); }));
}

function findRevenueColumn(rows, columns) {
  return columns.find(c =>
    rows.some(r => typeof r[c] === "number") &&
    ["revenue","sales","doanhthu","doanhso","gross","netamount","amount","turnover"].some(t => normalizeForMatch(c).includes(t))
  );
}

function firstNumericColumn(rows, columns) {
  return columns.find(c => rows.some(r => typeof r[c] === "number"));
}

function findColumnByTokens(columns, tokens) {
  return columns.find(c => { const n = normalizeForMatch(c); return tokens.some(t => n.includes(t)); });
}

// ═══════════════════════════════════════════════════════
// Shared analytics helpers
// ═══════════════════════════════════════════════════════

function selectMonthlyRows(rows) {
  const scoped = rows.filter(r => String(r.Scope ?? "") === "Monthly");
  if (rows.some(r => r.Scope !== undefined)) return scoped;
  return scoped.length ? scoped : rows;
}

function groupMetric(rows, dimension, metric) {
  const groups = new Map();
  for (const r of rows) {
    const label = String(r[dimension] ?? "").trim();
    if (!label) continue;
    groups.set(label, (groups.get(label) ?? 0) + numericValue(r[metric]));
  }
  return [...groups.entries()].map(([label, value]) => ({ label, value }));
}

function businessMetricTotal(rows, metric) {
  const monthlyRows = selectMonthlyRows(rows);
  if (monthlyRows.length) {
    return monthlyRows.reduce((s, r) => s + numericValue(r[metric]), 0);
  }
  return rows.reduce((s, r) => s + numericValue(r[metric]), 0);
}

function aggregateRows(rows, columns) {
  const agg = {};
  for (const c of columns) {
    const vals = rows.map(r => r[c]).filter(v => v !== null && v !== undefined);
    if (vals.some(v => typeof v === "number")) {
      const nums = vals.filter(v => typeof v === "number" && Number.isFinite(v));
      const norm = normalizeForMatch(c);
      agg[c] = norm.includes("avg") || norm.includes("pct") || norm.includes("margin") ? average(nums) : nums.reduce((s,v) => s+v, 0);
    } else if (typeof vals[0] === "string" || typeof vals[0] === "boolean") {
      agg[c] = vals[0];
    }
  }
  return agg;
}

function volumeNarrative(executive) {
  if (executive.highUnits === undefined || executive.lowUnits === undefined) return "The query did not return units, so the report can only confirm revenue extremes.";
  const unitDelta = executive.highUnits - executive.lowUnits;
  const aspText   = executive.highAsp !== undefined && executive.lowAsp !== undefined
    ? ` ASP moved from ${formatNumber(executive.lowAsp)} to ${formatNumber(executive.highAsp)}.`
    : "";
  return `Peak month sold ${formatNumber(unitDelta)} more units than trough month.${aspText}`;
}

function impliedAsp(revenue, units, fallback?) {
  if (units && units !== 0) return (revenue / units) * 1000;
  return fallback;
}

function contributionRead(value, total) {
  const share = total ? value / total : 0;
  if (share >= 0.25) return "Strategic concentration";
  if (share >= 0.10) return "Scale contributor";
  return "Long-tail contributor";
}

function crossActionCue(row, metric) {
  const marginCol  = findColumnByTokens(Object.keys(row), ["margin"]);
  const discountCol = findColumnByTokens(Object.keys(row), ["discount"]);
  const margin   = marginCol   ? numericValue(row[marginCol])   : undefined;
  const discount = discountCol ? numericValue(row[discountCol]) : undefined;
  if (margin   !== undefined && margin   < 0.16)                       return "Fix margin before scaling";
  if (discount !== undefined && discount > numericValue(row[metric]) * 0.05) return "Audit discount leakage";
  return "Candidate for scale or replication";
}

function riskRead(row, invCol, discCol, mktCol, msCol) {
  const parts = [];
  if (invCol  && numericValue(row[invCol])  > 42)                                    parts.push("inventory high");
  if (discCol && numericValue(row[discCol]) > numericValue(row.Revenue_BillionVND) * 0.04) parts.push("discount heavy");
  if (mktCol  && numericValue(row[mktCol])  > numericValue(row.Revenue_BillionVND) * 0.025) parts.push("marketing intensity high");
  if (msCol   && numericValue(row[msCol])   < 10)                                    parts.push("share weak");
  return parts.length ? parts.join("; ") : "monitor for next drill-down";
}

function averageByMonth(rows, monthCol, metricCol) {
  const totals = new Map();
  for (const r of rows) {
    const m = String(r[monthCol] ?? "").trim();
    if (!m) continue;
    totals.set(m, (totals.get(m) ?? 0) + numericValue(r[metricCol]));
  }
  return average([...totals.values()]);
}

function averageContributionByMonth(rows, monthCol, dimCol, dimVal, metricCol) {
  const totals = new Map();
  for (const r of rows) {
    const m = String(r[monthCol] ?? "").trim();
    if (!m || String(r[dimCol] ?? "").trim() !== dimVal) continue;
    totals.set(m, (totals.get(m) ?? 0) + numericValue(r[metricCol]));
  }
  return average([...totals.values()]);
}

function sumRows(rows, col) {
  return rows.reduce((s, r) => s + numericValue(r[col]), 0);
}

function average(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function maxFromRows(rows, col) {
  return Math.max(...rows.map(r => parseFormattedNumber(r[col])), 0);
}

function parseFormattedNumber(value) {
  if (!value) return 0;
  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function compareDimension(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

// ═══════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════

function formatMetricValue(metric, value) {
  const n = normalizeForMatch(metric);
  if (n.includes("billionvnd")) return `${formatNumber(value)} tỷ VND`;
  if (n.includes("millionvnd")) return `${formatNumber(value)} triệu VND`;
  if (n.includes("pct") || n.includes("margin")) {
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    return `${formatNumber(pct)}%`;
  }
  return formatNumber(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
}

function formatPercent(value) {
  return `${formatNumber(value * 100)}%`;
}

function cleanColumnName(value) {
  const cleaned = value
    .replace(/^\[[^\]]+\]\./, "")
    .replace(/^'([^']+)'\[([^\]]+)\]$/, "$1 $2")
    .replace(/^[^\[]+\[([^\]]+)\]$/, "$1")
    .trim();
  return cleaned.replace(/^\[|\]$/g, "").trim() || value;
}

// ═══════════════════════════════════════════════════════
// Language detection
// ═══════════════════════════════════════════════════════

function prefersVietnamese(value) {
  return /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(value)
    || /\b(thang|tháng|doanh thu|tai sao|tại sao|cao nhat|cao nhất|thap nhat|thấp nhất)\b/i.test(stripVietnamese(value));
}

function asksForMonthExtremes(value) {
  const n = stripVietnamese(value).toLowerCase();
  const asksMonth   = /\b(thang|month|monthly)\b/.test(n);
  const asksExtreme = /\b(cao nhat|thap nhat|max|min|highest|lowest|best|worst)\b/.test(n);
  const asksRevenue = /\b(doanh thu|revenue|sales)\b/.test(n);
  return asksMonth && (asksExtreme || asksRevenue);
}

function stripVietnamese(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

function normalizeForMatch(value) {
  return stripVietnamese(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function looksLikeMonthValue(value) {
  const n = stripVietnamese(value).toLowerCase().trim();
  return /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|thang)\b/.test(n)
    || /^\d{4}[-/]\d{1,2}$/.test(n)
    || /^\d{1,2}[-/]\d{4}$/.test(n);
}

// ═══════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function slugify(value) {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "report";
}

function unique(values) { return [...new Set(values)]; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPrimitive(value) { return value === null || ["string","number","boolean"].includes(typeof value); }

async function writeDashboardFile(title, html) {
  const outputDir = resolve(
    process.env.POWERBI_REPORT_OUTPUT_DIR ||
    process.env.POWERBI_DASHBOARD_OUTPUT_DIR ||
    "powerbi-report-output"
  );
  await mkdir(outputDir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}.html`;
  const path = resolve(outputDir, filename);
  await writeFile(path, html, "utf8");
  return path;
}
