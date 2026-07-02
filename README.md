# mcp-powerBI-to-report

Claude-compatible MCP server for discovering Fabric/Power BI workspaces, querying semantic models, and returning executive answers as both text and self-contained HTML reports.

This repo wraps Microsoft's official [`powerbi-modeling-mcp`](https://github.com/microsoft/powerbi-modeling-mcp) and relies entirely on its XMLA/TOM authentication path (no REST catalog login, no device-login auth).

## Tools

- `list_semantic_models_in_workspace`
- `get_known_workspace_catalog`
- `plan_multi_semantic_report`
- `execute_multi_semantic_report`
- `execute_dax_query`
- `execute_dax_report_query`
- `execute_dax_dashboard_query` (compatibility alias)

## Quick Install for Claude Desktop

Requires `git`, `node` (>= 18), and `npm` (>= 9) on `PATH`. The installers install production dependencies, use the prebuilt `dist/server.js`, write `.env`, and merge the server into Claude Desktop's `mcpServers` config. **Close Claude Desktop completely (system tray Quit, not just the window) before running any of these** — otherwise Claude may overwrite the config while the installer is editing it.

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace GSM_MCP_POC_WORKSPACE
```

Don't have Git/Node yet? Install Homebrew + `git node` first, then run the command above.

### Windows (PowerShell)

Recommended one-command setup — clones/updates the repo, installs dependencies, and configures Claude Desktop:

```powershell
iwr -UseBasicParsing "https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/install-windows.ps1" -OutFile "$env:TEMP\install-powerbi-mcp.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-powerbi-mcp.ps1" -Workspace "GSM_MCP_POC_WORKSPACE"
```

If you already have the repo cloned locally, run the same installer directly instead:

```powershell
cd <path-to-repo>
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Workspace "GSM_MCP_POC_WORKSPACE"
```

Useful flags on `install-windows.ps1`:

| Flag | Purpose |
|---|---|
| `-RepoDir <path>` | Where to clone/update the repo (default `~\mcp-powerBI-to-report`) |
| `-CorporateNpm` | Temporarily sets `npm_config_strict_ssl=false` for corporate SSL-inspection proxies (reverted automatically). Use only if the normal command fails on certificate/proxy errors. Does not bypass gateway blocks like `403 MediaTypeBlocked` — the proper enterprise fix is an internal npm registry, trusted CA (`npm cafile` / `NODE_EXTRA_CA_CERTS`), gateway whitelist, or offline-provisioned Microsoft binary. |
| `-Clean` | Removes `node_modules` before reinstalling |
| `-SkipPrereqInstall` | Skip attempting to install missing prerequisites |

If the repo is already cloned with a dirty working tree, or you just want to (re)configure Claude Desktop without touching the repo, call the config-only script directly:

```powershell
cd <path-to-repo>
npm install --omit=dev --include=optional
powershell -ExecutionPolicy Bypass -File scripts\setup-claude-desktop.ps1 -Workspace "GSM_MCP_POC_WORKSPACE"
```

Portable Node.js: set `$env:NODE_PORTABLE_HOME` before running if you need a specific Node build instead of the one on `PATH`.

Expected success output:

```text
Claude Desktop config updated: C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json
Local env written: C:\Users\<you>\mcp-powerBI-to-report\.env
Start Claude Desktop again, then use MCP server: mcp-powerBI-to-report
```

On Windows, all installers resolve the Modeling MCP command in this order: native `.exe` -> local `node_modules\.bin\powerbi-modeling-mcp.cmd` -> `npx` fallback.

### If IT policy blocks installers

Ask IT to install Git, Node.js LTS (includes npm), and Claude Desktop, then run the setup command for your OS above.

### After setup

Restart Claude Desktop, then ask it:

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
```

If diagnostics are clean:

```text
Use mcp-powerBI-to-report to list semantic models in workspace GSM_MCP_POC_WORKSPACE.
```

## Manual Install

```bash
git clone https://github.com/qlinh99/claude-mcp-powerBI-to-report.git
cd claude-mcp-powerBI-to-report
npm install --omit=dev --include=optional
npm run setup
```

`npm run setup` interactively asks for the Microsoft `powerbi-modeling-mcp` command/args, known workspace names, default CEO workspace, and optional semantic-model/report-output-dir fallbacks, then writes a local `.env` (mode `0600`) that the server loads on start.

On macOS, `npm install` also ad-hoc signs the Microsoft native Modeling MCP binary so Claude can launch it without an unsigned-binary failure — rerun it if Claude Desktop reports a launch error.

On Windows, the command resolution order is the same as above: `node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe` -> `node_modules\.bin\powerbi-modeling-mcp.cmd` -> `npx`.

## Claude Desktop Config Reference

### 1. Config file location

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows (standard) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Store/MSIX) | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |

> Close Claude Desktop completely before editing this file by hand — otherwise Claude can overwrite it and remove `mcpServers`.

### 2. mcpServers entry

Minimal (uses `.env` written by `npm run setup`):

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/claude-mcp-powerBI-to-report/dist/server.js"]
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
      "args": ["/absolute/path/to/claude-mcp-powerBI-to-report/dist/server.js"],
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

Platform-specific `command`/`POWERBI_MODELING_MCP_COMMAND` values:

| Platform | `command` | `POWERBI_MODELING_MCP_COMMAND` |
|---|---|---|
| macOS Apple Silicon | `/opt/homebrew/bin/node` | `.../node_modules/@microsoft/powerbi-modeling-mcp-darwin-arm64/dist/powerbi-modeling-mcp` |
| macOS Intel | `/usr/local/bin/node` | `.../node_modules/@microsoft/powerbi-modeling-mcp-darwin-x64/dist/powerbi-modeling-mcp` |
| Windows (native exe) | absolute path to `node.exe` | `...\node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe` |
| Windows (local shim) | absolute path to `node.exe` | `...\node_modules\.bin\powerbi-modeling-mcp.cmd` |
| Windows (npx fallback) | absolute path to `node.exe` | `C:\Program Files\nodejs\npx.cmd` with args `-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive` |

> **Windows note:** the bridge launches `.cmd` commands and `npx` through the Windows shell. Without that, Node can fail with `spawn npx ENOENT`.

A ready-to-edit example is at [`docs/claude-desktop-config.example.json`](docs/claude-desktop-config.example.json).

### 3. Local development (no build step)

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-mcp-powerBI-to-report/src/server.ts"]
    }
  }
}
```

### 4. Agent auto setup

```bash
npm run setup:agent -- --workspaces your-workspace-name
# or write straight to Claude Desktop config (auto-backed up):
npm run setup:agent -- --workspaces your-workspace-name --write-desktop-config
```

## Authentication

This MCP entirely delegates authentication to the underlying Microsoft `@microsoft/powerbi-modeling-mcp` tool, via its interactive auth mode or explicit args in `POWERBI_MODELING_MCP_ARGS`.

## Usage

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
Use mcp-powerBI-to-report to list semantic models in workspace test-mcp.
```

The workspace name must be known and provided — if missing, Claude should ask instead of guessing.

For a CEO workflow, set:

```env
POWERBI_KNOWN_WORKSPACES=test-mcp
POWERBI_DEFAULT_WORKSPACE=test-mcp
# Optional fallback only. Prefer letting Claude choose from workspace schema.
# POWERBI_DEFAULT_SEMANTIC_MODEL=hospital
# Optional folder for generated HTML reports.
# POWERBI_REPORT_OUTPUT_DIR=/path/to/powerbi-report-output
```

Claude then uses `get_known_workspace_catalog` to list models, picks the relevant one from schema/context, and calls `execute_dax_report_query` for business questions. The wrapper keeps the Modeling MCP process alive across a session, so follow-up questions reuse the same connection and avoid repeated login prompts.

`execute_dax_report_query` returns a text summary, `insights`/`insightCards` (what/why/so-what/action/confidence/evidence), a `dataProfile` (detected measures, dimensions, row/column counts, gaps), `nextQuestions`, `structuredContent` (rows, columns, generated HTML), an embedded `text/html` MCP resource, and `reportPath`/`reportUri` to open the generated file. Use `execute_dax_query` only when raw query output is enough.

### Multi-semantic executive reports

One CEO question can need evidence from more than one semantic model — e.g. revenue in `sale_vehicle-vf`, campaign spend/leads in a separate marketing model. Recommended flow:

```text
question → get_known_workspace_catalog → plan_multi_semantic_report
→ one DAX query per semantic model/evidence role → execute_multi_semantic_report
→ text answer + HTML report
```

`plan_multi_semantic_report` decides whether one or multiple models are needed, the decision intent (`variance_decomposition`, `opportunity_prioritization`, `portfolio_decision`, `forecast_risk`), required evidence, model roles, join grain/keys, dashboard blocks, and warns when evidence is missing or can't prove causality.

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

Rows are tagged with `DataSource`, `WorkspaceName`, `SemanticModelName`, `EvidenceRole` and stay combined in `structuredContent.rows` for audit, but the HTML report keeps each query's dataset separate rather than forcing everything into one chart — it profiles each result's shape and renders dataset-specific evidence blocks (data sources/quality, join grain/keys/confidence, grain-mismatch warnings, time-series/ranking/cross-dimension blocks, scorecards for shallow queries, and an executive synthesis board of what each model proves and what's still missing).

**Important:** if semantic models don't share the requested grain, the report stays in source-separated mode and treats cross-source findings as directional correlation, not proven causality. To compare/join models directly, aggregate each DAX query to the same `joinKeys` first (e.g. `Month x Province x Model`).

### Revenue month extremes

For questions like `Tháng nào có doanh thu thấp nhất, cao nhất và tại sao?`, prefer `execute_dax_report_query` with DAX returning a month/date column, a numeric revenue column, and explanatory driver columns your model has (order count, customer count, average ticket, product/category, region, branch, channel):

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

The report generator auto-detects month/revenue columns, aggregates by month, and returns the high/low months in `summary`/`insights`. For explanation questions (`why`, `tại sao`, `vì sao`, highest/lowest), it first runs an evidence-sufficiency gate: scans columns via `INFO.COLUMNS()`, infers available dimensions (`Region`, `Model`, `Province`, `Dealer`, `Campaign`) and drivers (units, ASP, margin, discount, marketing, inventory, market share), infers the focus period, runs slice-gap queries across dimensions, and renders an `Evidence acquired before conclusion` section showing what was queried vs. genuinely missing from the schema.

The HTML report adds an executive decision layer (`What happened`, `Why it happened`, `So what`, revenue bridge, driver tree, decision levers, run-rate read, evidence tables) and only marks fields like `Dealer`/`Campaign`/`Lead`/`Conversion` as missing after an actual schema scan.

## CEO Operating Mode

- Keep Claude Desktop and this MCP server running during the session; avoid restarting between related questions — the first query in a fresh session may trigger Microsoft auth, follow-ups reuse the existing connection.
- Configure `POWERBI_KNOWN_WORKSPACES` and `POWERBI_DEFAULT_WORKSPACE`. Treat `POWERBI_DEFAULT_SEMANTIC_MODEL` as an optional fallback, not required.
- Ask business questions in plain language; Claude generates DAX and calls `execute_dax_report_query`.

## HTML Report Output

Standalone HTML files with KPI cards, executive answer/driver tree/revenue bridge/decision levers/run-rate read, `WHAT`/`WHY`/`SO WHAT`/`NOW WHAT` insight layers, contribution analysis, self-contained SVG charts (line, combo bar+line, pie, donut, scatter, map) chosen by data shape, cross-dimension pockets, a risk/opportunity watch, and next-best drill-down questions — governed by Power-BI-like chart rules (line for time series, ranked bar for larger category sets, donut only for small part-to-whole mixes, heatmap for cross-dimension pockets, scatter only with sufficient numeric observations, map only for true geography fields).

Raw rows stay available in `structuredContent.rows` for audit/debug; multi-semantic runs also expose `structuredContent.datasets` and `structuredContent.datasetProfiles`.

Files are written to `POWERBI_REPORT_OUTPUT_DIR`, then `POWERBI_DASHBOARD_OUTPUT_DIR` (compatibility), otherwise `./powerbi-report-output` from the MCP process's working directory.

## Environment

```bash
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

## Notes

- The Microsoft Modeling MCP bridge defaults to `npx -y @microsoft/powerbi-modeling-mcp@latest --start`. Override with `POWERBI_MODELING_MCP_COMMAND` / `POWERBI_MODELING_MCP_ARGS` for a signed local binary.
- Local verification notes: [`docs/verification.md`](docs/verification.md).
