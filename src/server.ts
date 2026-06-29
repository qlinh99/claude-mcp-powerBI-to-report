#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildDashboardResponse } from "./dashboard.js";
import type { ReportDataset } from "./datasetProfiler.js";
import { loadEnvFile } from "./env.js";
import { ModelingMcpBridge } from "./modelingMcpBridge.js";

loadEnvFile();

const modelingBridge = new ModelingMcpBridge();

const server = new McpServer({
  name: "mcp-powerBI-to-report",
  version: "0.1.0"
});

const semanticModelCandidateSchema = z.object({
  workspaceName: z.string().optional(),
  semanticModelName: z.string(),
  description: z.string().optional(),
  availableFields: z.array(z.string()).optional()
});

const semanticQuerySchema = z.object({
  workspaceName: z.string().optional(),
  semanticModelName: z.string(),
  query: z.string(),
  evidenceRole: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  maxRows: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional()
});

server.registerTool(
  "list_semantic_models_in_workspace",
  {
    title: "List semantic models in known workspace via Microsoft Modeling MCP",
    description: "Use Microsoft powerbi-modeling-mcp/XMLA auth to list semantic models inside a known workspace name. The workspace name must be explicit; if it is missing, ask the user instead of guessing.",
    inputSchema: {
      workspaceName: z.string().describe("Exact Fabric/Power BI workspace name, for example 'test-mcp'.")
    }
  },
  async ({ workspaceName }) => {
    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName,
      semanticModels: await modelingBridge.listSemanticModelsInWorkspace(workspaceName)
    });
  }
);

server.registerTool(
  "get_known_workspace_catalog",
  {
    title: "Get known workspace semantic model catalog",
    description: "List semantic models for manually configured POWERBI_KNOWN_WORKSPACES using Microsoft Modeling MCP. Use this for CEO workflows.",
    inputSchema: {
      workspaceNames: z.array(z.string()).optional().describe("Optional workspace names. Defaults to POWERBI_KNOWN_WORKSPACES, then POWERBI_DEFAULT_WORKSPACE.")
    }
  },
  async ({ workspaceNames }) => {
    const names = uniqueNonEmpty(workspaceNames?.length ? workspaceNames : configuredWorkspaces());
    if (names.length === 0) {
      throw new Error("No known workspaces configured. Set POWERBI_KNOWN_WORKSPACES or POWERBI_DEFAULT_WORKSPACE.");
    }

    const workspaces = [];
    for (const workspaceName of names) {
      workspaces.push({
        name: workspaceName,
        semanticModels: await modelingBridge.listSemanticModelsInWorkspace(workspaceName)
      });
    }

    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaces
    });
  }
);

server.registerTool(
  "plan_multi_semantic_report",
  {
    title: "Plan an executive report across one or more semantic models",
    description: "Help an agent decide whether a CEO question needs one or multiple Power BI semantic models. Returns decision intent, required evidence, recommended model roles, join grain, report blocks, warnings, and a ReportSpec skeleton. This tool does not execute DAX; it plans the dashboard framework for the agent.",
    inputSchema: {
      question: z.string().describe("Executive business question."),
      audience: z.string().optional().default("ceo_mba").describe("Audience profile, for example ceo_mba, analyst, board."),
      workspaceName: z.string().optional().describe("Default workspace when candidate models omit workspaceName."),
      semanticModels: z.array(semanticModelCandidateSchema).optional().describe("Candidate semantic models with optional field hints. If omitted, the plan uses generic evidence roles.")
    }
  },
  async ({ question, audience, workspaceName, semanticModels }) => {
    const plan = planMultiSemanticReport({
      question,
      audience: audience || "ceo_mba",
      workspaceName,
      semanticModels: semanticModels ?? []
    });
    return jsonResult({
      source: "mcp-powerBI-to-report",
      plan
    });
  }
);

server.registerTool(
  "execute_multi_semantic_report",
  {
    title: "Execute multiple DAX queries and build one executive report",
    description: "Run DAX queries against multiple Power BI semantic models, tag each returned row with source/evidence metadata, validate join grain and evidence quality, then render one adaptive executive HTML report. Use this when one CEO question needs revenue plus marketing, inventory, finance, dealer, or other semantic models.",
    inputSchema: {
      question: z.string().describe("Executive business question."),
      title: z.string().optional().describe("Optional report title."),
      workspaceName: z.string().optional().describe("Default workspace for queries that omit workspaceName."),
      queries: z.array(semanticQuerySchema).min(1).describe("One DAX query per semantic model/evidence source."),
      joinKeys: z.array(z.string()).optional().describe("Common grain keys such as Month, Province, Model, Dealer."),
      grain: z.string().optional().describe("Human-readable join grain, for example Month x Province x Model."),
      reportSpec: z.record(z.string(), z.any()).optional().describe("Optional agent-authored ReportSpec used for traceability."),
      format: z.enum(["text", "html", "both"]).optional().default("both").describe("Output format: 'text' for JSON summary only, 'html' for HTML report only, 'both' for both."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ question, title, workspaceName, queries, joinKeys, grain, reportSpec, format, maxRows, timeoutSeconds }) => {
    return multiSemanticReportResult({
      question,
      title,
      workspaceName,
      queries,
      joinKeys,
      grain,
      reportSpec,
      format,
      maxRows,
      timeoutSeconds
    });
  }
);

server.registerTool(
  "execute_dax_query",
  {
    title: "Execute DAX query with CEO defaults",
    description: "Execute a DAX query against a Power BI semantic model using default workspace/model when omitted. This keeps the Microsoft Modeling MCP process alive to reduce repeated login prompts.",
    inputSchema: {
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ query, workspaceName, semanticModelName, maxRows, timeoutSeconds }) => {
    const workspace = workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE;
    const model = semanticModelName || process.env.POWERBI_DEFAULT_SEMANTIC_MODEL;
    if (!workspace || !model) {
      throw new Error("Missing workspace/model. Set POWERBI_DEFAULT_WORKSPACE and POWERBI_DEFAULT_SEMANTIC_MODEL, or pass workspaceName and semanticModelName.");
    }

    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName: workspace,
      semanticModelName: model,
      result: await modelingBridge.executeDaxQuery({
        workspaceName: workspace,
        semanticModelName: model,
        query,
        maxRows,
        timeoutSeconds
      })
    });
  }
);

server.registerTool(
  "execute_dax_report_query",
  {
    title: "Execute DAX query and build HTML executive report",
    description: "Execute a DAX query against a Power BI semantic model and return both a concise text answer and a self-contained HTML dashboard/report for executive review. Prefer this tool for boss/CEO business questions. For questions such as 'which month had the highest/lowest revenue and why', write DAX that returns a month column, a revenue/sales metric column, and when possible explanatory drivers such as orders, customers, average ticket, product/category, region, or channel.",
    inputSchema: {
      question: z.string().describe("The business question from the executive user."),
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      title: z.string().optional().describe("Optional report title. Defaults to the question."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      format: z.enum(["text", "html", "both"]).optional().default("both").describe("Output format: 'text' for JSON summary only, 'html' for HTML report only, 'both' for both."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ question, query, title, workspaceName, semanticModelName, format, maxRows, timeoutSeconds }) => {
    return reportResult({
      question,
      query,
      title,
      workspaceName,
      semanticModelName,
      format,
      maxRows,
      timeoutSeconds
    });
  }
);

server.registerTool(
  "execute_dax_dashboard_query",
  {
    title: "Execute DAX query and build HTML dashboard",
    description: "Alias for execute_dax_report_query kept for compatibility with earlier dashboard workflows. For revenue-by-month questions, return month, revenue/sales, and available driver columns so the report can explain highest and lowest months.",
    inputSchema: {
      question: z.string().describe("The business question from the executive user."),
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      title: z.string().optional().describe("Optional dashboard title. Defaults to the question."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      format: z.enum(["text", "html", "both"]).optional().default("both").describe("Output format: 'text' for JSON summary only, 'html' for HTML report only, 'both' for both."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ question, query, title, workspaceName, semanticModelName, format, maxRows, timeoutSeconds }) => {
    return reportResult({
      question,
      query,
      title,
      workspaceName,
      semanticModelName,
      format,
      maxRows,
      timeoutSeconds
    });
  }
);

async function reportResult(options: {
  question: string;
  query: string;
  title?: string;
  workspaceName?: string;
  semanticModelName?: string;
  format?: "text" | "html" | "both";
  maxRows?: number;
  timeoutSeconds?: number;
}) {
  const workspace = options.workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE;
  const model = options.semanticModelName || process.env.POWERBI_DEFAULT_SEMANTIC_MODEL;
  if (!workspace || !model) {
    throw new Error("Missing workspace/model. Set POWERBI_DEFAULT_WORKSPACE and POWERBI_DEFAULT_SEMANTIC_MODEL, or pass workspaceName and semanticModelName.");
  }

  const result = await modelingBridge.executeDaxQuery({
    workspaceName: workspace,
    semanticModelName: model,
    query: options.query,
    maxRows: options.maxRows,
    timeoutSeconds: options.timeoutSeconds
  });
  const dashboard = await buildDashboardResponse({
    question: options.question,
    title: options.title,
    workspaceName: workspace,
    semanticModelName: model,
    query: options.query,
    result
  });

  const format = options.format || "both";
  const textPayload = {
    source: "microsoft-powerbi-modeling-mcp",
    workspaceName: workspace,
    semanticModelName: model,
    question: options.question,
    summary: dashboard.summary,
    insights: dashboard.insights,
    insightCards: dashboard.insightCards,
    dataProfile: dashboard.dataProfile,
    nextQuestions: dashboard.nextQuestions,
    reportPath: dashboard.dashboardPath,
    reportUri: dashboard.dashboardUri,
    generatedAt: dashboard.generatedAt,
    columns: dashboard.columns,
    rowCount: dashboard.rows.length
  };
  const htmlResource = {
    type: "resource" as const,
    resource: {
      uri: dashboard.dashboardUri,
      mimeType: "text/html",
      text: dashboard.html
    }
  };
  const content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  > = [];
  if (format === "text" || format === "both") {
    content.push({ type: "text" as const, text: JSON.stringify(textPayload, null, 2) });
  }
  if (format === "html" || format === "both") {
    content.push(htmlResource);
  }

  return {
    content,
    structuredContent: {
      ...textPayload,
      dashboardPath: dashboard.dashboardPath,
      dashboardUri: dashboard.dashboardUri,
      rows: dashboard.rows,
      html: dashboard.html
    }
  };
}

async function multiSemanticReportResult(options: {
  question: string;
  title?: string;
  workspaceName?: string;
  queries: Array<{
    workspaceName?: string;
    semanticModelName: string;
    query: string;
    evidenceRole?: string;
    evidence?: string[];
    maxRows?: number;
    timeoutSeconds?: number;
  }>;
  joinKeys?: string[];
  grain?: string;
  reportSpec?: Record<string, unknown>;
  format?: "text" | "html" | "both";
  maxRows?: number;
  timeoutSeconds?: number;
}) {
  const defaultWorkspace = options.workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE;
  const combinedRows: Record<string, unknown>[] = [];
  const datasets: ReportDataset[] = [];
  const dataSources = [];
  const warnings: string[] = [];

  for (const querySpec of options.queries) {
    const workspace = querySpec.workspaceName || defaultWorkspace;
    if (!workspace) {
      throw new Error(`Missing workspace for semantic model ${querySpec.semanticModelName}. Pass workspaceName or set POWERBI_DEFAULT_WORKSPACE.`);
    }
    const result = await modelingBridge.executeDaxQuery({
      workspaceName: workspace,
      semanticModelName: querySpec.semanticModelName,
      query: querySpec.query,
      maxRows: querySpec.maxRows ?? options.maxRows,
      timeoutSeconds: querySpec.timeoutSeconds ?? options.timeoutSeconds
    });
    const rows = extractRows(result);
    const sourceName = `${workspace}/${querySpec.semanticModelName}`;
    const evidenceRole = querySpec.evidenceRole || inferEvidenceRole(querySpec.semanticModelName, querySpec.evidence);
    const datasetRows = rows.map(row => ({
      ...row,
      DataSource: sourceName,
      WorkspaceName: workspace,
      SemanticModelName: querySpec.semanticModelName,
      EvidenceRole: evidenceRole
    }));
    for (const row of rows) {
      combinedRows.push({
        ...row,
        DataSource: sourceName,
        WorkspaceName: workspace,
        SemanticModelName: querySpec.semanticModelName,
        EvidenceRole: evidenceRole
      });
    }
    datasets.push({
      id: normalizeText(`${querySpec.semanticModelName}-${evidenceRole}`) || `dataset-${datasets.length + 1}`,
      label: querySpec.semanticModelName,
      workspaceName: workspace,
      semanticModelName: querySpec.semanticModelName,
      evidenceRole,
      evidence: querySpec.evidence ?? [],
      rows: datasetRows,
      columns: uniqueNonEmpty(datasetRows.flatMap(row => Object.keys(row)))
    });
    dataSources.push({
      workspaceName: workspace,
      semanticModelName: querySpec.semanticModelName,
      evidenceRole,
      evidence: querySpec.evidence ?? [],
      rowCount: rows.length
    });
    if (rows.length === 0) {
      warnings.push(`${sourceName} returned no rows.`);
    }
  }

  const validation = validateMultiSemanticEvidence({
    rows: combinedRows,
    dataSources,
    joinKeys: options.joinKeys ?? [],
    grain: options.grain
  });
  warnings.push(...validation.warnings);

  const dashboard = await buildDashboardResponse({
    question: options.question,
    title: options.title,
    workspaceName: defaultWorkspace || dataSources[0]?.workspaceName,
    semanticModelName: dataSources.map(source => source.semanticModelName).join(" + "),
    query: options.queries.map(query => `-- ${query.semanticModelName}\n${query.query}`).join("\n\n"),
    result: { data: combinedRows },
    datasets,
    dataSources,
    joinPlan: validation.joinPlan,
    validationWarnings: warnings,
    reportSpec: options.reportSpec
  });

  const payload = {
    source: "mcp-powerBI-to-report",
    mode: "multi-semantic",
    question: options.question,
    summary: dashboard.summary,
    insights: dashboard.insights,
    insightCards: dashboard.insightCards,
    dataProfile: dashboard.dataProfile,
    datasetProfiles: dashboard.datasetProfiles,
    nextQuestions: dashboard.nextQuestions,
    dataSources,
    joinPlan: validation.joinPlan,
    validationWarnings: warnings,
    reportSpec: options.reportSpec,
    reportPath: dashboard.dashboardPath,
    reportUri: dashboard.dashboardUri,
    generatedAt: dashboard.generatedAt,
    columns: dashboard.columns,
    rowCount: dashboard.rows.length
  };

  const format = options.format || "both";
  const htmlResource = {
    type: "resource" as const,
    resource: {
      uri: dashboard.dashboardUri,
      mimeType: "text/html",
      text: dashboard.html
    }
  };
  const content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  > = [];
  if (format === "text" || format === "both") {
    content.push({ type: "text" as const, text: JSON.stringify(payload, null, 2) });
  }
  if (format === "html" || format === "both") {
    content.push(htmlResource);
  }

  return {
    content,
    structuredContent: {
      ...payload,
      dashboardPath: dashboard.dashboardPath,
      dashboardUri: dashboard.dashboardUri,
      rows: dashboard.rows,
      datasets: dashboard.datasets,
      datasetProfiles: dashboard.datasetProfiles,
      html: dashboard.html
    }
  };
}

function planMultiSemanticReport(options: {
  question: string;
  audience: string;
  workspaceName?: string;
  semanticModels: Array<{
    workspaceName?: string;
    semanticModelName: string;
    description?: string;
    availableFields?: string[];
  }>;
}) {
  const intent = inferExecutiveIntent(options.question);
  const requiredEvidence = requiredEvidenceForIntent(intent);
  const models = options.semanticModels.length
    ? options.semanticModels
    : [{ workspaceName: options.workspaceName, semanticModelName: process.env.POWERBI_DEFAULT_SEMANTIC_MODEL || "primary-semantic-model" }];
  const recommendedSources = models.map(model => {
    const fields = model.availableFields ?? [];
    const evidence = requiredEvidence.filter(item => fieldListMatchesEvidence(fields, item) || modelNameMatchesEvidence(model.semanticModelName, item));
    return {
      workspaceName: model.workspaceName || options.workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE,
      semanticModelName: model.semanticModelName,
      evidence: evidence.length ? evidence : [inferEvidenceRole(model.semanticModelName, fields)],
      role: inferEvidenceRole(model.semanticModelName, evidence.length ? evidence : fields)
    };
  });
  const joinKeys = inferJoinKeys(options.question, requiredEvidence, models.flatMap(model => model.availableFields ?? []));
  const warnings = [];
  if (recommendedSources.length < 2) {
    warnings.push("Only one candidate semantic model was provided; multi-semantic orchestration is optional for this question.");
  }
  if (joinKeys.length === 0) {
    warnings.push("No obvious join keys detected. Agent should align results at the safest common grain before combining evidence.");
  }

  return {
    intent,
    audience: options.audience,
    decisionNeed: decisionNeedForIntent(intent),
    requiredEvidence,
    recommendedSources,
    joinPlan: {
      grain: joinKeys.length ? joinKeys.join(" x ") : "source-specific evidence; no direct join",
      joinKeys,
      confidence: joinKeys.length >= 2 ? "high" : joinKeys.length === 1 ? "medium" : "directional"
    },
    reportSpec: {
      intent,
      audience: options.audience,
      outputMode: "html",
      density: "executive",
      blocks: blocksForIntent(intent)
    },
    warnings,
    agentInstructions: [
      "Inspect each semantic model schema before writing DAX.",
      "Return each query with common grain columns when possible, for example Month, Province, Model, Dealer.",
      "Use execute_multi_semantic_report when evidence must be rendered as one report.",
      "If evidence lives at different grains, report correlation and limitations instead of claiming causality."
    ]
  };
}

function inferExecutiveIntent(question: string): string {
  const q = normalizeText(question);
  if (/\b(forecast|du bao|du kien|thang toi|quy toi|nam toi)\b/.test(q)) return "forecast_risk";
  if (/\b(if|neu|scenario|gia su|tang|giam|discount|price)\b/.test(q)) return "scenario_simulation";
  if (/\b(tinh nao|province|region|dau tu|opportunity|co hoi)\b/.test(q)) return "opportunity_prioritization";
  if (/\b(model|product|scale|portfolio|san pham)\b/.test(q)) return "portfolio_decision";
  if (/\b(dealer|daily|showroom|salesperson|performance)\b/.test(q)) return "performance_management";
  if (/\b(tai sao|why|vi sao|giam|gap|variance|lech)\b/.test(q)) return "variance_decomposition";
  if (/\b(thang|month|cao nhat|thap nhat|highest|lowest)\b/.test(q)) return "diagnostic_extreme";
  return "executive_diagnostic";
}

function requiredEvidenceForIntent(intent: string): string[] {
  const base = ["Revenue", "UnitsSold", "Margin", "Time"];
  const byIntent: Record<string, string[]> = {
    diagnostic_extreme: ["ASP", "Model", "Region", "Province", "Discount", "Inventory"],
    variance_decomposition: ["ASP", "ModelMix", "Region", "Province", "Dealer", "Discount", "Marketing", "Inventory"],
    opportunity_prioritization: ["Growth", "MarketShare", "Margin", "Province", "Model", "DealerCoverage", "Inventory"],
    portfolio_decision: ["Model", "Growth", "MarketShare", "Margin", "Discount", "Inventory", "Region"],
    performance_management: ["Dealer", "Target", "Conversion", "Inventory", "Margin", "Discount"],
    scenario_simulation: ["Price", "Discount", "Elasticity", "UnitsSold", "Margin", "Scenario"],
    forecast_risk: ["Pipeline", "Trend", "Seasonality", "Inventory", "Marketing", "Plan"],
    executive_diagnostic: ["Model", "Region", "Province", "Discount", "Inventory", "Marketing"]
  };
  return uniqueNonEmpty([...base, ...(byIntent[intent] ?? byIntent.executive_diagnostic)]);
}

function decisionNeedForIntent(intent: string): string {
  const map: Record<string, string> = {
    diagnostic_extreme: "explain highest/lowest performance and identify repeatable or avoidable drivers",
    variance_decomposition: "separate controllable drivers from mix/timing effects",
    opportunity_prioritization: "rank where to invest next with risk and margin guardrails",
    portfolio_decision: "decide which model/product to scale, protect, fix, or deprioritize",
    performance_management: "identify underperforming operating units and corrective actions",
    scenario_simulation: "estimate impact range under management levers",
    forecast_risk: "project likely outcome and surface risks to plan",
    executive_diagnostic: "convert metrics into decision-ready evidence"
  };
  return map[intent] ?? map.executive_diagnostic;
}

function blocksForIntent(intent: string): string[] {
  const common = ["executive_answer", "evidence_quality", "next_questions"];
  const map: Record<string, string[]> = {
    diagnostic_extreme: ["kpi_strip", "monthly_extreme", "driver_tree", "waterfall", "contribution", "cross_dimension_pockets", "risk_watch"],
    variance_decomposition: ["variance_bridge", "driver_tree", "contribution", "cross_dimension_pockets", "missing_evidence"],
    opportunity_prioritization: ["opportunity_scorecard", "geo_or_province_ranking", "portfolio_matrix", "risk_watch"],
    portfolio_decision: ["portfolio_matrix", "model_contribution", "margin_guardrail", "region_model_pockets", "risk_watch"],
    performance_management: ["performance_scorecard", "dealer_ranking", "target_attainment", "risk_watch"],
    scenario_simulation: ["scenario_matrix", "sensitivity_table", "risk_watch"],
    forecast_risk: ["trend", "run_rate", "forecast_band", "risk_watch"],
    executive_diagnostic: ["kpi_strip", "contribution", "cross_dimension_pockets", "risk_watch"]
  };
  return [...common.slice(0, 1), ...(map[intent] ?? map.executive_diagnostic), ...common.slice(1)];
}

function inferJoinKeys(question: string, evidence: string[], fields: string[]): string[] {
  const candidates = ["Month", "Date", "YearMonth", "Region", "Province", "Model", "Dealer", "Channel", "Campaign"];
  const haystack = normalizeText([question, ...evidence, ...fields].join(" "));
  return candidates.filter(key => haystack.includes(normalizeText(key)));
}

function fieldListMatchesEvidence(fields: string[], evidence: string): boolean {
  const e = normalizeText(evidence);
  return fields.some(field => normalizeText(field).includes(e) || e.includes(normalizeText(field)));
}

function modelNameMatchesEvidence(modelName: string, evidence: string): boolean {
  const name = normalizeText(modelName);
  const e = normalizeText(evidence);
  return name.includes(e) || (name.includes("sale") && ["revenue","unitssold","model","province","region"].includes(e)) ||
    (name.includes("marketing") && ["marketing","campaign","conversion","pipeline"].includes(e)) ||
    (name.includes("inventory") && ["inventory","stock"].includes(e)) ||
    (name.includes("finance") && ["margin","discount","profit","cash"].includes(e));
}

function inferEvidenceRole(modelName: string, evidence?: string[]): string {
  const name = normalizeText(modelName);
  const text = normalizeText((evidence ?? []).join(" "));
  if (name.includes("marketing") || text.includes("marketing") || text.includes("campaign")) return "marketing";
  if (name.includes("inventory") || text.includes("inventory") || text.includes("stock")) return "inventory";
  if (name.includes("finance") || text.includes("margin") || text.includes("profit")) return "finance";
  if (name.includes("dealer") || text.includes("dealer")) return "dealer";
  if (name.includes("sale") || text.includes("revenue")) return "sales";
  return "supporting_evidence";
}

function validateMultiSemanticEvidence(options: {
  rows: Record<string, unknown>[];
  dataSources: Array<{ semanticModelName: string; rowCount: number }>;
  joinKeys: string[];
  grain?: string;
}) {
  const columns = uniqueNonEmpty(options.rows.flatMap(row => Object.keys(row)));
  const warnings: string[] = [];
  const missingJoinKeys = options.joinKeys.filter(key => !columns.some(col => normalizeText(col) === normalizeText(key)));
  if (missingJoinKeys.length) {
    warnings.push(`Join keys not returned by combined result: ${missingJoinKeys.join(", ")}.`);
  }
  if (options.dataSources.length > 1 && options.joinKeys.length === 0) {
    warnings.push("Multiple semantic models were used without explicit joinKeys; report should treat cross-source explanation as directional.");
  }
  const emptySources = options.dataSources.filter(source => source.rowCount === 0);
  for (const source of emptySources) warnings.push(`${source.semanticModelName} returned zero rows.`);
  const confidence = options.dataSources.length <= 1
    ? "single-source"
    : missingJoinKeys.length === 0 && options.joinKeys.length >= 2
      ? "high"
      : missingJoinKeys.length === 0 && options.joinKeys.length === 1
        ? "medium"
        : "directional";
  return {
    warnings,
    joinPlan: {
      grain: options.grain || (options.joinKeys.length ? options.joinKeys.join(" x ") : "source-specific evidence"),
      joinKeys: options.joinKeys,
      confidence
    }
  };
}

function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (!isRecord(result)) return [];
  if (Array.isArray(result.data)) return result.data.filter(isRecord);
  if (Array.isArray(result.rows)) return rowsFromRowsColumns(result.rows, Array.isArray(result.columns) ? result.columns : undefined).filter(isRecord);
  if (isRecord(result.result)) return extractRows(result.result);
  if (isRecord(result.data)) return extractRows(result.data);
  return [];
}

function rowsFromRowsColumns(rows: unknown[], columns?: unknown[]): Record<string, unknown>[] {
  if (!columns) return rows.filter(isRecord);
  const names = columns.map((column, index) => isRecord(column) ? String(column.name ?? column.columnName ?? `Column ${index + 1}`) : String(column || `Column ${index + 1}`));
  return rows.map(row => {
    if (Array.isArray(row)) return Object.fromEntries(row.map((value, index) => [names[index] || `Column ${index + 1}`, value]));
    return isRecord(row) ? row : {};
  });
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

function configuredWorkspaces(): string[] {
  return [
    ...(process.env.POWERBI_KNOWN_WORKSPACES || "").split(","),
    process.env.POWERBI_DEFAULT_WORKSPACE || ""
  ];
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
