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

## Quick Install for Claude Desktop

Use these commands for a one-time setup on a new device.

The setup installs production npm dependencies, uses the prebuilt `dist/server.js`, writes `.env`, updates Claude Desktop `mcpServers`, and writes the resolved absolute Node.js command into Claude config. On Windows it configures the Microsoft Modeling MCP command in this order:

```text
native .exe -> local node_modules\.bin\powerbi-modeling-mcp.cmd -> npx fallback
```

It also enforces:

```text
Node.js >= 18
npm >= 9
```

and configures:

```text
POWERBI_MODELING_MCP_ARGS=--start --authmode=interactive
```

This project does not use REST catalog login or device-login auth.

### macOS - Git and Node already installed

```bash
curl -fsSL https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace GSM_MCP_POC_WORKSPACE
```

The macOS setup resolves `node` with `command -v node` and writes that absolute path, for example `/opt/homebrew/bin/node`, into `claude_desktop_config.json`.

### macOS - Install Git/Node first, then setup MCP

```bash
if ! command -v brew >/dev/null 2>&1; then /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; fi; eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null || true)"; brew install git node; curl -fsSL https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace GSM_MCP_POC_WORKSPACE
```

### Windows PowerShell - recommended one-command setup

Use this command first on company Windows devices. It uses `node`, `npm`, and `git` already available on `PATH`, validates Node.js 18+/npm 9+, clones or fast-forwards the repo, installs dependencies, writes Claude Desktop config, and exits with a clear error if the repo has local changes.

```powershell
$ErrorActionPreference="Stop"; Set-Location $HOME; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "Claude*" } | Stop-Process -Force; if ($env:NODE_PORTABLE_HOME -and (Test-Path (Join-Path $env:NODE_PORTABLE_HOME "node.exe"))) { $env:Path="$env:NODE_PORTABLE_HOME;$env:Path" }; $dir=Join-Path $HOME "mcp-powerBI-to-report"; $nodeCmd=Get-Command node.exe -ErrorAction SilentlyContinue; if (-not $nodeCmd) { $nodeCmd=Get-Command node -ErrorAction SilentlyContinue }; if (-not $nodeCmd) { throw "Node.js 18+ is required but node was not found on PATH" }; $npmCmd=Get-Command npm.cmd -ErrorAction SilentlyContinue; if (-not $npmCmd) { $npmCmd=Get-Command npm -ErrorAction SilentlyContinue }; if (-not $npmCmd) { throw "npm 9+ is required but npm was not found on PATH" }; $gitCmd=Get-Command git.exe -ErrorAction SilentlyContinue; if (-not $gitCmd) { $gitCmd=Get-Command git -ErrorAction SilentlyContinue }; if (-not $gitCmd) { throw "Git is required but git was not found on PATH" }; $nodeExe=$nodeCmd.Source; $nodeVersionText=(& $nodeExe -v).Trim(); if ($LASTEXITCODE -ne 0) { throw "node failed" }; $nodeMajor=[int]($nodeVersionText.TrimStart([char]"v").Split(".")[0]); if ($nodeMajor -lt 18) { throw "Node.js 18 or newer is required. Current: $nodeVersionText at $nodeExe" }; $npmVersionText=(& $npmCmd.Source -v).Trim(); if ($LASTEXITCODE -ne 0) { throw "npm failed" }; $npmMajor=[int]($npmVersionText.Split(".")[0]); if ($npmMajor -lt 9) { throw "npm 9 or newer is required. Current: $npmVersionText" }; Write-Host "Using Node: $nodeExe ($nodeVersionText)"; Write-Host "Using npm: $($npmCmd.Source) ($npmVersionText)"; if (-not (Test-Path "$dir\.git")) { git clone "https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git" $dir; if ($LASTEXITCODE -ne 0) { throw "git clone failed" } } else { Set-Location $dir; git pull --ff-only; if ($LASTEXITCODE -ne 0) { throw "git pull failed. Resolve local changes before continuing." } }; Set-Location $dir; & $npmCmd.Source install --omit=dev --include=optional; if ($LASTEXITCODE -ne 0) { throw "npm install failed" }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\setup-claude-desktop.ps1" -Workspace "GSM_MCP_POC_WORKSPACE" -NodeCommand $nodeExe -SkipInstall; if ($LASTEXITCODE -ne 0) { throw "Claude Desktop setup failed" }; Write-Host "Installation completed successfully. Start Claude Desktop again."
```

This is the normal Windows setup command. Do not use the corporate npm command below unless npm fails because of corporate certificate/proxy behavior.

The setup script writes the resolved absolute `node.exe` path into `claude_desktop_config.json`, so Claude Desktop uses the same Node runtime later.

Portable Node.js is optional. If a device needs it, set `NODE_PORTABLE_HOME` first, then run the standard command:

```powershell
$env:NODE_PORTABLE_HOME="D:\ApprovedTools\node-v22.12.0-win-x64"
```

Expected success output includes:

```text
Claude Desktop config updated: C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json
Local env written: C:\Users\<you>\mcp-powerBI-to-report\.env
Start Claude Desktop again, then use MCP server: mcp-powerBI-to-report
```

Close Claude Desktop completely before running setup. Use Quit from the system tray, not just the window close button, so Claude does not overwrite `claude_desktop_config.json` while setup is editing it.

The Windows setup script also stops running Claude Desktop processes before writing config, backs up the existing config, recovers from the latest valid backup if the current config is invalid JSON, writes through a temp file, then validates JSON before and after replacing the live config.

### Windows PowerShell - optional corporate npm mode

Use this only when the normal command fails because the company network requires temporary npm SSL compatibility. It still requires `node`, `npm`, and `git` on `PATH`.

```powershell
$dir="$HOME\mcp-powerBI-to-report"; if (!(Test-Path "$dir\.git")) { git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git $dir }; cd $dir; powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Workspace "GSM_MCP_POC_WORKSPACE" -CorporateNpm -Clean
```

`-CorporateNpm` is a temporary compatibility mode for approved test environments. It only sets `npm_config_strict_ssl=false` inside the installer process, cleans npm cache, then removes that override in `finally`. It does not bypass gateway blocks such as `403 MediaTypeBlocked`. The preferred enterprise path is still:

- internal npm registry
- trusted Root CA via `npm cafile` / `NODE_EXTRA_CA_CERTS`
- gateway whitelist
- approved offline provisioning of the Microsoft binary

### Windows PowerShell - existing dirty repo

Use this if the repo is already cloned, the working tree is dirty, or you want to skip `git pull`.

```powershell
$ErrorActionPreference="Stop"; Set-Location $HOME; if ($env:NODE_PORTABLE_HOME -and (Test-Path (Join-Path $env:NODE_PORTABLE_HOME "node.exe"))) { $env:Path="$env:NODE_PORTABLE_HOME;$env:Path" }; $dir=Join-Path $HOME "mcp-powerBI-to-report"; if (-not (Test-Path "$dir\.git")) { throw "Repository not found: $dir" }; $nodeCmd=Get-Command node.exe -ErrorAction SilentlyContinue; if (-not $nodeCmd) { $nodeCmd=Get-Command node -ErrorAction SilentlyContinue }; if (-not $nodeCmd) { throw "Node.js 18+ is required but node was not found on PATH" }; $npmCmd=Get-Command npm.cmd -ErrorAction SilentlyContinue; if (-not $npmCmd) { $npmCmd=Get-Command npm -ErrorAction SilentlyContinue }; if (-not $npmCmd) { throw "npm 9+ is required but npm was not found on PATH" }; $nodeExe=$nodeCmd.Source; $nodeVersionText=(& $nodeExe -v).Trim(); $nodeMajor=[int]($nodeVersionText.TrimStart([char]"v").Split(".")[0]); if ($nodeMajor -lt 18) { throw "Node.js 18 or newer is required. Current: $nodeVersionText at $nodeExe" }; $npmVersionText=(& $npmCmd.Source -v).Trim(); $npmMajor=[int]($npmVersionText.Split(".")[0]); if ($npmMajor -lt 9) { throw "npm 9 or newer is required. Current: $npmVersionText" }; Set-Location $dir; & $npmCmd.Source install --omit=dev --include=optional; if ($LASTEXITCODE -ne 0) { throw "npm install failed" }; powershell -ExecutionPolicy Bypass -File scripts\setup-claude-desktop.ps1 -Workspace "GSM_MCP_POC_WORKSPACE" -NodeCommand $nodeExe -SkipInstall; if ($LASTEXITCODE -ne 0) { throw "Claude Desktop setup failed" }; Write-Host "Installation completed successfully. Start Claude Desktop again."
```

### Windows PowerShell - raw GitHub download

Use this only when `raw.githubusercontent.com` is allowed and you want to run only the installer script directly.

```powershell
iwr -UseBasicParsing "https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/install-windows.ps1" -OutFile "$env:TEMP\install-powerbi-mcp.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-powerbi-mcp.ps1" -Workspace "GSM_MCP_POC_WORKSPACE"
```

If company policy blocks Homebrew, `winget`, or app installation, ask IT to install:

- Git
- Node.js LTS, which includes npm
- Claude Desktop

Then run the matching setup command above again.

After setup, start Claude Desktop again and test:

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
```

Then test Power BI access:

```text
Use mcp-powerBI-to-report to list semantic models in workspace GSM_MCP_POC_WORKSPACE.
```

## Manual Install

Prerequisites:

- Node.js 18 or newer
- git

```bash
git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git
cd mcp-powerBI-to-report
npm install --omit=dev --include=optional
npm run setup
```

On macOS, `npm install --omit=dev --include=optional` also ad-hoc signs the Microsoft native Modeling MCP binary so Claude can launch it without the unsigned-binary failure.

On Windows, `npm run setup` and the PowerShell installer resolve the Modeling MCP command in this order:

```text
node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe
node_modules\.bin\powerbi-modeling-mcp.cmd
npx
```

`npm run setup` asks for:

- Microsoft `powerbi-modeling-mcp` command and args
- Known workspace names
- Default CEO workspace
- Optional default semantic model fallback
- Optional HTML report output folder

It writes a local `.env` file with mode `0600`. The MCP server loads this file automatically on start.

## Claude Desktop Setup Details

### One-line setup

The fastest path is the bundled Claude Desktop setup script. It detects macOS vs Windows shells, installs dependencies, uses the prebuilt `dist/server.js`, writes `.env`, backs up Claude Desktop config, and merges the MCP server into `mcpServers`. On Windows it prefers the native Microsoft Modeling MCP `.exe`, then the local `.cmd` shim, then `npx`.

From an existing clone:

```bash
bash scripts/setup-claude-desktop.sh --workspace test-mcp
```

From a fresh machine:

```bash
git clone https://github.com/nguyenanhducdeveloper86/mcp-powerBI-to-report.git
cd mcp-powerBI-to-report
bash scripts/setup-claude-desktop.sh --workspace test-mcp
```

Or one command that clones to `~/mcp-powerBI-to-report` when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace test-mcp
```

Windows should run the same command from Git Bash. The script writes Windows-native paths into Claude Desktop config and prefers:

```text
node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe
```

If that binary is missing, it uses:

```text
node_modules\.bin\powerbi-modeling-mcp.cmd
```

If both local commands are missing, it falls back to:

```text
npx -y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive
```

PowerShell users should use the native PowerShell setup script, not `curl -fsSL`:

```powershell
cd C:\Users\<you>\mcp-powerBI-to-report
powershell -ExecutionPolicy Bypass -File scripts\setup-claude-desktop.ps1 -Workspace GSM_MCP_POC_WORKSPACE
```

If downloading from GitHub in PowerShell, use `Invoke-WebRequest`:

```powershell
iwr -UseBasicParsing "https://raw.githubusercontent.com/nguyenanhducdeveloper86/mcp-powerBI-to-report/main/scripts/setup-claude-desktop.ps1" -OutFile setup-claude-desktop.ps1
powershell -ExecutionPolicy Bypass -File .\setup-claude-desktop.ps1 -Workspace GSM_MCP_POC_WORKSPACE
```

Optional npm alias:

```bash
npm run setup:claude-desktop -- --workspace test-mcp
```

PowerShell npm alias:

```powershell
npm run setup:claude-desktop:powershell -- -Workspace GSM_MCP_POC_WORKSPACE
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
      "command": "/opt/homebrew/bin/node",
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
      "command": "/usr/local/bin/node",
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

> **macOS note:** `npm install --omit=dev --include=optional` automatically ad-hoc signs the Microsoft native binary. If Claude Desktop shows an error launching the binary, run that command again from the project directory, then restart Claude Desktop.

Windows example with native `.exe`:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "C:\\Users\\<you>\\Tools\\node-v22.12.0-win-x64\\node.exe",
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

Windows example with local `.cmd` shim:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "C:\\Users\\<you>\\Tools\\node-v22.12.0-win-x64\\node.exe",
      "args": ["C:\\Users\\<you>\\mcp-powerBI-to-report\\dist\\server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "C:\\Users\\<you>\\mcp-powerBI-to-report\\node_modules\\.bin\\powerbi-modeling-mcp.cmd",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "C:\\Users\\<you>\\powerbi-report-output"
      }
    }
  }
}
```

Windows example with `npx` fallback:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "C:\\Users\\<you>\\Tools\\node-v22.12.0-win-x64\\node.exe",
      "args": ["C:\\Users\\<you>\\mcp-powerBI-to-report\\dist\\server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "C:\\Program Files\\nodejs\\npx.cmd",
        "POWERBI_MODELING_MCP_ARGS": "-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "C:\\Users\\<you>\\powerbi-report-output"
      }
    }
  }
}
```

> **Windows note:** the bridge launches `.cmd` commands and `npx` through the Windows shell. Without that behavior, Node can fail with `spawn npx ENOENT` on Windows.

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
It uses the Microsoft Modeling MCP interactive auth mode or explicit authentication arguments configured via `POWERBI_MODELING_MCP_ARGS`.

## Usage Examples

Ask Claude:

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
```

If diagnostics are clean, ask Claude:

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

The report generator automatically detects the month and revenue columns, aggregates revenue by month, and returns the highest and lowest months in `summary` and `insights`. For explanation questions (`why`, `tại sao`, `vì sao`, highest/lowest), it also runs an evidence sufficiency gate before rendering:

- scan semantic model columns with `INFO.COLUMNS()`
- infer available dimensions such as `Region`, `Model`, `Province`, `Dealer`, `Campaign`
- infer drivers such as units, ASP, margin, discount, marketing, inventory, market share
- infer the focus period from the question or returned rows
- run slice gap queries by available dimensions and cross-dimensions
- render an `Evidence acquired before conclusion` section showing what was queried and what schema is genuinely missing

The HTML report also adds an executive decision layer with `What happened`, `Why it happened`, `So what`, revenue bridge, driver tree, decision levers, run-rate read, and evidence tables. If the semantic model lacks fields such as `Dealer`, `Campaign`, `Lead`, or `Conversion`, the report marks those as missing only after schema scan.

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
- native self-contained SVG chart formats selected from returned data shape:
  line chart, combo bar+line chart, pie chart, donut chart, scatter plot, and map chart
- cross-dimension pockets such as `Province x Model`, `Region x Model`, or any dimension pair returned by the query
- risk/opportunity watch based on returned operational drivers such as margin, discount, inventory, marketing, and market share
- multi-semantic dataset blocks that choose chart/layout from the returned data shape instead of a fixed template
- chart governance rules closer to Power BI reporting practice:
  line for time series, ranked bar for larger category sets, donut only for small part-to-whole mixes, heatmap for cross-dimension pockets, scatter only for sufficient numeric observations, and map only for true geography fields
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
