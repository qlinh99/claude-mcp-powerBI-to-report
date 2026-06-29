export type DatasetShape =
  | "empty"
  | "time_series"
  | "categorical_ranking"
  | "cross_dimension"
  | "multi_metric"
  | "single_metric"
  | "raw_evidence";

export interface ReportDataset {
  id: string;
  label?: string;
  workspaceName?: string;
  semanticModelName?: string;
  evidenceRole?: string;
  evidence?: string[];
  rows: Record<string, unknown>[];
  columns?: string[];
}

export interface DatasetProfile {
  id: string;
  label: string;
  workspaceName?: string;
  semanticModelName?: string;
  evidenceRole?: string;
  evidence: string[];
  rowCount: number;
  columnCount: number;
  columns: string[];
  metrics: string[];
  primaryMetric?: string;
  timeDimensions: string[];
  categoricalDimensions: string[];
  primaryDimension?: string;
  grain: string;
  shape: DatasetShape;
  recommendedBlocks: string[];
}

const metadataColumns = new Set([
  "DataSource",
  "WorkspaceName",
  "SemanticModelName",
  "EvidenceRole",
  "Scope",
  "ScopeOrder"
]);

export function profileDataset(dataset: ReportDataset): DatasetProfile {
  const columns = unique([...(dataset.columns ?? []), ...dataset.rows.flatMap(row => Object.keys(row))]);
  const analyticColumns = columns.filter(column => !metadataColumns.has(column));
  const timeDimensions = analyticColumns.filter(column => isTimeColumn(column, dataset.rows));
  const metrics = analyticColumns.filter(column => !timeDimensions.includes(column) && dataset.rows.some(row => isFiniteNumber(row[column])));
  const categoricalDimensions = analyticColumns.filter(column => {
    if (metrics.includes(column) || timeDimensions.includes(column)) return false;
    const values = unique(dataset.rows.map(row => stringValue(row[column])).filter(Boolean));
    return values.length >= 1 && values.length <= Math.max(200, dataset.rows.length);
  });
  const primaryMetric = choosePrimaryMetric(metrics);
  const primaryDimension = timeDimensions[0] ?? choosePrimaryDimension(categoricalDimensions, dataset.rows);
  const shape = inferShape({
    rowCount: dataset.rows.length,
    metrics,
    timeDimensions,
    categoricalDimensions
  });

  return {
    id: dataset.id,
    label: dataset.label || dataset.semanticModelName || dataset.id,
    workspaceName: dataset.workspaceName,
    semanticModelName: dataset.semanticModelName,
    evidenceRole: dataset.evidenceRole,
    evidence: dataset.evidence ?? [],
    rowCount: dataset.rows.length,
    columnCount: analyticColumns.length,
    columns: analyticColumns,
    metrics,
    primaryMetric,
    timeDimensions,
    categoricalDimensions,
    primaryDimension,
    grain: inferGrain(timeDimensions, categoricalDimensions),
    shape,
    recommendedBlocks: recommendedBlocksForShape(shape)
  };
}

function inferShape(input: {
  rowCount: number;
  metrics: string[];
  timeDimensions: string[];
  categoricalDimensions: string[];
}): DatasetShape {
  if (input.rowCount === 0) return "empty";
  if (input.timeDimensions.length && input.metrics.length) return "time_series";
  if (input.categoricalDimensions.length >= 2 && input.metrics.length) return "cross_dimension";
  if (input.categoricalDimensions.length && input.metrics.length) return "categorical_ranking";
  if (input.metrics.length >= 2) return "multi_metric";
  if (input.metrics.length === 1) return "single_metric";
  return "raw_evidence";
}

function recommendedBlocksForShape(shape: DatasetShape): string[] {
  const map: Record<DatasetShape, string[]> = {
    empty: ["evidence_gap"],
    time_series: ["trend", "extremes", "run_rate", "anomaly_watch"],
    categorical_ranking: ["ranking", "contribution", "long_tail"],
    cross_dimension: ["pocket_heatmap", "contribution", "risk_watch"],
    multi_metric: ["metric_scorecard", "driver_scan"],
    single_metric: ["metric_scorecard"],
    raw_evidence: ["evidence_table"]
  };
  return map[shape];
}

function choosePrimaryMetric(metrics: string[]): string | undefined {
  const priority = [
    "revenue",
    "sales",
    "doanhthu",
    "amount",
    "profit",
    "margin",
    "cost",
    "visit",
    "count",
    "units",
    "unitssold",
    "quantity"
  ];
  return metrics.find(metric => priority.some(token => normalize(metric).includes(token))) ?? metrics[0];
}

function choosePrimaryDimension(dimensions: string[], rows: Record<string, unknown>[]): string | undefined {
  if (!dimensions.length) return undefined;
  const priority = ["province", "region", "model", "dealer", "customer", "campaign", "channel", "department"];
  return dimensions.find(dim => priority.some(token => normalize(dim).includes(token)))
    ?? dimensions
      .map(dim => ({ dim, count: unique(rows.map(row => stringValue(row[dim])).filter(Boolean)).length }))
      .sort((a, b) => b.count - a.count)[0]?.dim;
}

function inferGrain(timeDimensions: string[], categoricalDimensions: string[]): string {
  const grain = [...timeDimensions.slice(0, 1), ...categoricalDimensions.slice(0, 3)];
  return grain.length ? grain.join(" x ") : "single result";
}

function isTimeColumn(column: string, rows: Record<string, unknown>[]): boolean {
  const normalized = normalize(column);
  if (["yearmonth", "month", "period", "date", "visitdate", "thang", "ngay"].some(token => normalized.includes(token))) {
    return true;
  }
  return rows.some(row => {
    const value = row[column];
    return typeof value === "string" && looksLikeDateOrMonth(value);
  });
}

function looksLikeDateOrMonth(value: string): boolean {
  const normalized = normalize(value);
  return /^\d{4}\d{1,2}\d{1,2}$/.test(normalized)
    || /^\d{4}\d{1,2}$/.test(normalized)
    || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|thang)\d*/.test(normalized);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
