import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Primitive = string | number | boolean | null;
type DashboardRow = Record<string, Primitive>;

export type DashboardRequest = {
  question: string;
  title?: string;
  workspaceName: string;
  semanticModelName: string;
  query: string;
  result: unknown;
};

export type DashboardResponse = {
  summary: string;
  dashboardPath: string;
  dashboardUri: string;
  html: string;
  rows: DashboardRow[];
  columns: string[];
  generatedAt: string;
};

type Kpi = {
  label: string;
  value: string;
  tone: "green" | "blue" | "amber" | "red";
};

export async function buildDashboardResponse(request: DashboardRequest): Promise<DashboardResponse> {
  const generatedAt = new Date().toISOString();
  const table = normalizeDaxResult(request.result);
  const summary = buildExecutiveSummary(request.question, table.rows, table.columns);
  const html = renderDashboardHtml({
    ...request,
    rows: table.rows,
    columns: table.columns,
    summary,
    generatedAt
  });
  const dashboardPath = await writeDashboardFile(request.title || request.question, html);

  return {
    summary,
    dashboardPath,
    dashboardUri: `file://${dashboardPath}`,
    html,
    rows: table.rows,
    columns: table.columns,
    generatedAt
  };
}

function normalizeDaxResult(result: unknown): { rows: DashboardRow[]; columns: string[] } {
  const candidates = collectRowCandidates(result);
  const rows = candidates
    .map(row => normalizeRow(row))
    .filter((row): row is DashboardRow => row !== undefined);
  const columns = unique(rows.flatMap(row => Object.keys(row)));

  return { rows, columns };
}

function collectRowCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.rows)) return mapRowsWithColumns(value.rows, value.columns);

  const firstTable = firstArrayTable(value.tables) || firstArrayTable(value.results);
  if (firstTable) {
    if (Array.isArray(firstTable.rows)) {
      return mapRowsWithColumns(firstTable.rows, firstTable.columns);
    }
    if (Array.isArray(firstTable.data)) return firstTable.data;
  }

  if (isRecord(value.result)) return collectRowCandidates(value.result);
  if (isRecord(value.data)) return collectRowCandidates(value.data);

  return [value];
}

function firstArrayTable(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.rows) || Array.isArray(item.data)) return item;
    const nested = firstArrayTable(item.tables);
    if (nested) return nested;
  }
  return undefined;
}

function mapRowsWithColumns(rows: unknown[], columns: unknown): unknown[] {
  if (!Array.isArray(columns)) return rows;
  const names = columns.map((column, index) => {
    if (isRecord(column)) {
      return String(column.name ?? column.columnName ?? column.caption ?? `Column ${index + 1}`);
    }
    return String(column || `Column ${index + 1}`);
  });

  return rows.map(row => {
    if (!Array.isArray(row)) return row;
    return Object.fromEntries(row.map((value, index) => [names[index] || `Column ${index + 1}`, value]));
  });
}

function normalizeRow(value: unknown): DashboardRow | undefined {
  if (!isRecord(value)) return undefined;
  const row: DashboardRow = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrimitive(item)) row[cleanColumnName(key)] = item;
  }
  return Object.keys(row).length ? row : undefined;
}

function buildExecutiveSummary(question: string, rows: DashboardRow[], columns: string[]): string {
  if (rows.length === 0) {
    return `No rows were returned for: ${question}`;
  }

  const numericColumns = columns.filter(column => rows.some(row => typeof row[column] === "number"));
  const primaryMetric = numericColumns[0];
  const primaryDimension = columns.find(column => column !== primaryMetric && rows.some(row => typeof row[column] === "string"));

  if (!primaryMetric) {
    return `Returned ${rows.length} row${rows.length === 1 ? "" : "s"} for: ${question}`;
  }

  const total = rows.reduce((sum, row) => sum + numericValue(row[primaryMetric]), 0);
  const leader = primaryDimension
    ? [...rows].sort((a, b) => numericValue(b[primaryMetric]) - numericValue(a[primaryMetric]))[0]
    : undefined;

  const leaderText = leader && primaryDimension
    ? ` Highest ${primaryMetric} is ${String(leader[primaryDimension])} at ${formatNumber(numericValue(leader[primaryMetric]))}.`
    : "";

  return `${primaryMetric} totals ${formatNumber(total)} across ${rows.length} row${rows.length === 1 ? "" : "s"}.${leaderText}`;
}

function renderDashboardHtml(input: DashboardRequest & {
  rows: DashboardRow[];
  columns: string[];
  summary: string;
  generatedAt: string;
}): string {
  const title = input.title || "Executive Power BI Dashboard";
  const kpis = buildKpis(input.rows, input.columns);
  const dimension = input.columns.find(column => input.rows.some(row => typeof row[column] === "string"));
  const metric = input.columns.find(column => input.rows.some(row => typeof row[column] === "number"));
  const bars = dimension && metric ? buildBars(input.rows, dimension, metric) : [];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b1f23;
      --muted: #667085;
      --line: #d7dde5;
      --panel: #ffffff;
      --canvas: #f4f7fa;
      --green: #08875d;
      --blue: #1769aa;
      --amber: #b75f00;
      --red: #c5352b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--canvas);
      color: var(--ink);
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
      margin-bottom: 18px;
    }
    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; font-weight: 760; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 17px; line-height: 1.25; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    .meta { text-align: right; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    .card { min-height: 118px; padding: 16px; display: grid; align-content: space-between; }
    .label { color: var(--muted); font-size: 12px; line-height: 1.25; text-transform: uppercase; font-weight: 700; }
    .value { font-size: 27px; line-height: 1.15; font-weight: 760; overflow-wrap: anywhere; }
    .tone-green { border-top: 4px solid var(--green); }
    .tone-blue { border-top: 4px solid var(--blue); }
    .tone-amber { border-top: 4px solid var(--amber); }
    .tone-red { border-top: 4px solid var(--red); }
    .content { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr); gap: 18px; align-items: start; }
    .panel { padding: 18px; overflow: hidden; }
    .bars { display: grid; gap: 11px; }
    .bar-row { display: grid; grid-template-columns: minmax(120px, 190px) minmax(0, 1fr) minmax(86px, auto); gap: 12px; align-items: center; }
    .bar-label { font-size: 13px; color: #344054; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { height: 12px; border-radius: 999px; background: #e8eef5; overflow: hidden; }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--blue), var(--green)); }
    .bar-value { font-size: 13px; font-weight: 700; text-align: right; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef3f8; color: #344054; font-size: 12px; text-transform: uppercase; position: sticky; top: 0; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: 0; }
    .query { margin-top: 14px; padding: 12px; border-radius: 8px; background: #101828; color: #f2f4f7; overflow: auto; font-size: 12px; line-height: 1.45; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      header, .content { grid-template-columns: 1fr; }
      .meta { text-align: left; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 6px; }
      h1 { font-size: 24px; }
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
        <div>${escapeHtml(input.workspaceName)}</div>
        <div>${escapeHtml(input.semanticModelName)}</div>
        <div>${escapeHtml(new Date(input.generatedAt).toLocaleString("en-US"))}</div>
      </aside>
    </header>

    <section class="grid">
      ${kpis.map(kpi => `<article class="card tone-${kpi.tone}"><div class="label">${escapeHtml(kpi.label)}</div><div class="value">${escapeHtml(kpi.value)}</div></article>`).join("\n      ")}
    </section>

    <section class="content">
      <article class="panel">
        <h2>${escapeHtml(metric && dimension ? `${metric} by ${dimension}` : "Result Overview")}</h2>
        ${bars.length ? `<div class="bars">${bars.map(bar => `<div class="bar-row"><div class="bar-label" title="${escapeHtml(bar.label)}">${escapeHtml(bar.label)}</div><div class="track"><div class="fill" style="width:${bar.width}%"></div></div><div class="bar-value">${escapeHtml(bar.value)}</div></div>`).join("")}</div>` : `<p>No numeric series was available for a chart.</p>`}
      </article>

      <article class="panel">
        <h2>Data</h2>
        ${renderTable(input.rows, input.columns)}
      </article>
    </section>

    <section class="panel" style="margin-top:18px">
      <h2>Question</h2>
      <p>${escapeHtml(input.question)}</p>
      <pre class="query">${escapeHtml(input.query)}</pre>
    </section>
  </main>
</body>
</html>`;
}

function buildKpis(rows: DashboardRow[], columns: string[]): Kpi[] {
  const numericColumns = columns.filter(column => rows.some(row => typeof row[column] === "number"));
  const tones: Kpi["tone"][] = ["green", "blue", "amber", "red"];
  const metricKpis = numericColumns.slice(0, 3).map((column, index) => ({
    label: column,
    value: formatNumber(rows.reduce((sum, row) => sum + numericValue(row[column]), 0)),
    tone: tones[index]
  }));

  return [
    ...metricKpis,
    {
      label: "Rows returned",
      value: formatNumber(rows.length),
      tone: tones[metricKpis.length % tones.length]
    }
  ].slice(0, 4);
}

function buildBars(rows: DashboardRow[], dimension: string, metric: string): { label: string; value: string; width: number }[] {
  const sorted = [...rows]
    .sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]))
    .slice(0, 12);
  const max = Math.max(...sorted.map(row => Math.abs(numericValue(row[metric]))), 1);

  return sorted.map(row => {
    const value = numericValue(row[metric]);
    return {
      label: String(row[dimension] ?? "Unspecified"),
      value: formatNumber(value),
      width: Math.max(3, Math.round((Math.abs(value) / max) * 100))
    };
  });
}

function renderTable(rows: DashboardRow[], columns: string[]): string {
  if (rows.length === 0 || columns.length === 0) return "<p>No rows returned.</p>";
  const visibleRows = rows.slice(0, 100);

  return `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${visibleRows.map(row => `<tr>${columns.map(column => {
    const value = row[column];
    const numeric = typeof value === "number";
    return `<td class="${numeric ? "number" : ""}">${escapeHtml(numeric ? formatNumber(value) : String(value ?? ""))}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function writeDashboardFile(title: string, html: string): Promise<string> {
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

function numericValue(value: Primitive | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
}

function cleanColumnName(value: string): string {
  return value
    .replace(/^\[[^\]]+\]\./, "")
    .replace(/^\[|\]$/g, "")
    .replace(/^'([^']+)'\[([^\]]+)\]$/, "$1 $2")
    .trim() || value;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "dashboard";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
