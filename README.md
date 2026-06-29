# mcp-powerBI-to-report

Claude-compatible MCP server for discovering Fabric/Power BI workspaces, querying semantic models, and returning executive answers as both text and self-contained HTML reports.

This repo wraps Microsoft's official [`powerbi-modeling-mcp`](https://github.com/microsoft/powerbi-modeling-mcp). It relies entirely on the XMLA/TOM authentication path provided by that official tool.

## Tools

- `list_semantic_models_in_workspace`
- `get_known_workspace_catalog`
- `plan_multi_semantic_report`
- `execute_multi_semantic_report`
- `execute_dax_query`
- `execute_dax_report_query`
- `execute_dax_dashboard_query` (compatibility alias)

## Install

Prerequisites:

- Node.js 18 or newer
- git

```bash
git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git
cd mcp-powerBI-to-report
npm install
npm run setup
npm run build
```

On macOS, `npm install` also ad-hoc signs the Microsoft native Modeling MCP binary so Claude can launch it without the unsigned-binary failure.

On Windows, point `POWERBI_MODELING_MCP_COMMAND` to the native Microsoft Modeling MCP executable instead of `npx`:

```text
node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe
```

`npm run setup` asks for:

- Microsoft `powerbi-modeling-mcp` command and args
- Known workspace names
- Default CEO workspace
- Optional default semantic model fallback
- Optional HTML report output folder

It writes a local `.env` file with mode `0600`. The MCP server loads this file automatically on start.

## Claude Desktop Setup

### One-line setup

The fastest path is the bundled Claude Desktop setup script. It detects macOS vs Windows shells, installs dependencies, builds `dist/server.js`, selects the native Microsoft Power BI Modeling MCP binary for the current device, writes `.env`, backs up Claude Desktop config, and merges the MCP server into `mcpServers`.

From an existing clone:

```bash
bash scripts/setup-claude-desktop.sh --workspaces test-mcp --model sale_vehicle-vf
```

From a fresh machine:

```bash
git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git
cd mcp-powerBI-to-report
bash scripts/setup-claude-desktop.sh --workspaces test-mcp --model sale_vehicle-vf
```

Or one command that clones to `~/mcp-powerBI-to-report` when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspaces test-mcp --model sale_vehicle-vf
```

Windows should run the same command from Git Bash. The script writes Windows-native paths into Claude Desktop config and points `POWERBI_MODELING_MCP_COMMAND` directly to:

```text
node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe
```

Optional npm alias:

```bash
npm run setup:claude-desktop -- --workspaces test-mcp --model sale_vehicle-vf
```

After the script finishes, restart Claude Desktop completely.

### 1. Locate the config file

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows (standard) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Store/MSIX) | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |

> **Important:** Close Claude Desktop completely before editing the config file. Otherwise Claude can overwrite the file and remove `mcpServers`.

### 2. Add the MCP server

Minimal config (uses env vars from the `.env` file written by `npm run setup`):

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-powerBI-to-report/dist/server.js"]
    }
  }
}
```

Full config with explicit env overrides:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-powerBI-to-report/dist/server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "/absolute/path/to/powerbi-modeling-mcp",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "/absolute/path/to/powerbi-report-output"
      }
    }
  }
}
```

macOS example — Apple Silicon (M1/M2/M3):

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/Users/<you>/mcp-powerBI-to-report/dist/server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "/Users/<you>/mcp-powerBI-to-report/node_modules/@microsoft/powerbi-modeling-mcp-darwin-arm64/dist/powerbi-modeling-mcp",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "/Users/<you>/powerbi-report-output"
      }
    }
  }
}
```

macOS example — Intel (x64):

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/Users/<you>/mcp-powerBI-to-report/dist/server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "/Users/<you>/mcp-powerBI-to-report/node_modules/@microsoft/powerbi-modeling-mcp-darwin-x64/dist/powerbi-modeling-mcp",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "/Users/<you>/powerbi-report-output"
      }
    }
  }
}
```

> **macOS note:** `npm install` automatically ad-hoc signs the Microsoft native binary. If Claude Desktop shows an error launching the binary, run `npm install` again from the project directory, then restart Claude Desktop.

Windows example:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\mcp-powerBI-to-report\\dist\\server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "C:\\Users\\<you>\\mcp-powerBI-to-report\\node_modules\\@microsoft\\powerbi-modeling-mcp-win32-x64\\dist\\powerbi-modeling-mcp.exe",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "C:\\Users\\<you>\\powerbi-report-output"
      }
    }
  }
}
```

> **Windows note:** Do not use `npx` as `POWERBI_MODELING_MCP_COMMAND`. Always point directly to the `.exe` binary path above.

A ready-to-edit example file is at [`docs/claude-desktop-config.example.json`](docs/claude-desktop-config.example.json).

### 3. For local development (without building)

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-powerBI-to-report/src/server.ts"]
    }
  }
}
```

### 4. Agent auto setup

Claude agents can generate or write Claude Desktop configuration with:

```bash
npm run setup:agent -- --workspaces your-workspace-name
```

Write directly to Claude Desktop config with an automatic backup:

```bash
npm run setup:agent -- --workspaces your-workspace-name --write-desktop-config
```

## Authentication

This MCP entirely delegates authentication to the underlying Microsoft `@microsoft/powerbi-modeling-mcp` tool. 
It uses Microsoft's interactive device flow or explicit credential arguments configured via `POWERBI_MODELING_MCP_ARGS`.

## Usage Examples

Ask Claude:

```text
Use mcp-powerBI-to-report to list semantic models in workspace test-mcp.
```

The workspace name must be known and provided. If the workspace/model is not provided, Claude should ask the user for the workspace name instead of guessing.

For a CEO workflow, set:

```env
POWERBI_KNOWN_WORKSPACES=test-mcp
POWERBI_DEFAULT_WORKSPACE=test-mcp
# Optional fallback only. Prefer letting Claude choose from workspace schema.
# POWERBI_DEFAULT_SEMANTIC_MODEL=hospital
# Optional folder for generated HTML reports.
# POWERBI_REPORT_OUTPUT_DIR=/path/to/powerbi-report-output
```

Then Claude can use `get_known_workspace_catalog` to list models from configured workspaces, choose the relevant semantic model from schema/context, and call `execute_dax_report_query` for follow-up business questions. The wrapper keeps the Microsoft Modeling MCP process alive, so repeated questions reuse the same process and reduce repeated login prompts.

`execute_dax_report_query` returns:

- concise text summary for chat
- `insights` for detected executive findings such as highest/lowest revenue month and returned data drivers
- `insightCards` with structured `what`, `why`, `soWhat`, `action`, `confidence`, evidence, and missing-data notes
- `dataProfile` with detected measures, dimensions, row/column counts, and gaps that limit deeper root-cause analysis
- `nextQuestions` for CEO/MBA-style drill-down prompts
- `structuredContent` with rows, columns, and generated HTML
- embedded MCP `text/html` resource
- `reportPath` and `reportUri` for opening the generated local `.html` file

Use `execute_dax_query` only when raw query output is enough.

### Multi-semantic executive reports

One CEO question can require evidence from more than one semantic model. For example, revenue may live in `sale_vehicle-vf`, while campaign spend, leads, inventory, dealer coverage, or finance margin can live in separate semantic models.

Recommended agent flow:

```text
question
→ get_known_workspace_catalog
→ plan_multi_semantic_report
→ write one DAX query per semantic model/evidence role
→ execute_multi_semantic_report
→ return text answer + HTML report
```

`plan_multi_semantic_report` helps the agent decide:

- whether one or multiple semantic models are needed
- decision intent such as `variance_decomposition`, `opportunity_prioritization`, `portfolio_decision`, or `forecast_risk`
- required evidence
- recommended model roles
- join grain and join keys
- dashboard blocks for the ReportSpec
- warnings when evidence is missing or cannot prove causality

`execute_multi_semantic_report` accepts multiple DAX queries:

```json
{
  "question": "Doanh thu VF tháng nào cao nhất và tại sao?",
  "grain": "Month x Province x Model",
  "joinKeys": ["Month", "Province", "Model"],
  "queries": [
    {
      "workspaceName": "test-mcp",
      "semanticModelName": "sale_vehicle-vf",
      "evidenceRole": "sales",
      "evidence": ["Revenue", "UnitsSold", "Model", "Province"],
      "query": "EVALUATE ..."
    },
    {
      "workspaceName": "test-mcp",
      "semanticModelName": "marketing-vf",
      "evidenceRole": "marketing",
      "evidence": ["CampaignSpend", "Leads", "ConversionRate"],
      "query": "EVALUATE ..."
    }
  ]
}
```

The report tags rows with `DataSource`, `WorkspaceName`, `SemanticModelName`, and `EvidenceRole`. For audit compatibility, combined rows remain in `structuredContent.rows`, but the HTML report does **not** force all semantic models into one chart. It keeps each query result as a separate dataset, profiles the returned shape, and renders dataset-specific evidence blocks:

- data sources and evidence quality
- join grain, join keys, and confidence
- validation warnings when semantic models are at different grains
- dataset profiles with detected grain, metrics, dimensions, and visual shape
- time-series blocks for time-grain datasets
- ranking/contribution blocks for categorical datasets
- cross-dimension pocket blocks when multiple dimensions are returned
- metric scorecards or evidence tables when the query is too shallow for stronger visuals
- an executive synthesis board showing what each semantic model can prove, what decision it supports, and what evidence is still missing

Important rule: if semantic models do not share the requested grain, the report should stay in `source-separated evidence` mode and describe cross-source findings as directional correlation, not proven causality. To compare or join models directly, the agent must aggregate each DAX query to the same `joinKeys` first, for example `Month x Province x Model`.

### Revenue month extremes

For questions like:

```text
Tháng nào có doanh thu thấp nhất, cao nhất và tại sao?
```

Prefer `execute_dax_report_query` and write DAX that returns:

- a month/date period column
- a numeric revenue/sales/doanh thu column
- explanatory driver columns when the model has them, such as order count, customer count, average ticket, product/category, region, branch, or channel

The report generator automatically detects the month and revenue columns, aggregates revenue by month, and returns the highest and lowest months in `summary` and `insights`. The HTML report also adds an executive decision layer with `What happened`, `Why it happened`, `So what`, revenue bridge, driver tree, decision levers, run-rate read, and an evidence table.

Example DAX query shape:

```dax
EVALUATE
SUMMARIZECOLUMNS(
  'Date'[YearMonth],
  'Product'[Category],
  'Region'[RegionName],
  "Revenue", [Revenue],
  "Orders", [Orders],
  "Customers", [Customers],
  "Average Ticket", DIVIDE([Revenue], [Orders])
)
ORDER BY 'Date'[YearMonth]
```

## CEO Operating Mode

For the simplest CEO experience:

- Keep Claude Desktop and this MCP server running during the working session.
- Avoid restarting Claude between related questions.
- Configure `POWERBI_DEFAULT_WORKSPACE` and `POWERBI_DEFAULT_SEMANTIC_MODEL`.
- Configure `POWERBI_KNOWN_WORKSPACES` and `POWERBI_DEFAULT_WORKSPACE`.
- Treat `POWERBI_DEFAULT_SEMANTIC_MODEL` as an optional fallback, not a required CEO input.
- Ask business questions in plain language; Claude should generate DAX and call `execute_dax_report_query`.

The first query in a fresh session can still trigger Microsoft authentication. Follow-up queries in the same running MCP session reuse the existing Microsoft Modeling MCP process and connection.

## HTML Report Output

Reports are generated as standalone HTML files with:

- KPI cards for numeric measures
- executive answer, driver tree, revenue bridge, decision levers, and run-rate read
- executive insight layers: `WHAT`, `WHY`, `SO WHAT`, and `NOW WHAT`
- contribution analysis across detected dimensions
- cross-dimension pockets such as `Province x Model`, `Region x Model`, or any dimension pair returned by the query
- risk/opportunity watch based on returned operational drivers such as margin, discount, inventory, marketing, and market share
- multi-semantic dataset blocks that choose chart/layout from the returned data shape instead of a fixed template
- next-best business questions for CEO drill-down
- question, workspace, semantic model, and DAX query context

Raw returned rows remain available in MCP `structuredContent.rows` for audit/debug. Multi-semantic runs also expose `structuredContent.datasets` and `structuredContent.datasetProfiles` so agents can inspect why a specific dashboard block was chosen. The HTML report is designed as a decision brief rather than a raw data table.

Files are written to `POWERBI_REPORT_OUTPUT_DIR` when set, then `POWERBI_DASHBOARD_OUTPUT_DIR` for compatibility, otherwise `./powerbi-report-output` from the MCP process working directory.

## Environment

Copy `.env.example` for local shell usage:

```bash
cp .env.example .env
```

Then export values before running:

```bash
set -a
source .env
set +a
npm run dev
```

## Notes

- The Microsoft Modeling MCP bridge uses `npx -y @microsoft/powerbi-modeling-mcp@latest --start` by default. Override with `POWERBI_MODELING_MCP_COMMAND` and `POWERBI_MODELING_MCP_ARGS` if you have a signed local binary.
- Local verification notes are in [`docs/verification.md`](docs/verification.md).
