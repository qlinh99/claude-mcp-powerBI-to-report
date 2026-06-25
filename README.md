# mcp-powerBI-to-report

Claude-compatible MCP server for discovering Fabric/Power BI workspaces, querying semantic models, and returning executive answers as both text and self-contained HTML reports.

This repo is intentionally based around Microsoft's official [`powerbi-modeling-mcp`](https://github.com/microsoft/powerbi-modeling-mcp):

- `get_catalog`, `list_workspaces`, and `list_semantic_models` use the Power BI REST API for tenant/workspace discovery.
- `list_semantic_models_in_workspace_via_modeling_mcp` launches Microsoft `@microsoft/powerbi-modeling-mcp` and uses its XMLA/TOM auth path to enumerate semantic models inside a known workspace.

That split is necessary because Microsoft Power BI Modeling MCP can connect and model/query semantic models, but it does not expose a tenant-wide workspace discovery tool.

## Tools

- `auth_status`
- `start_device_login`
- `complete_device_login`
- `list_workspaces`
- `list_semantic_models`
- `get_catalog`
- `list_semantic_models_in_workspace_via_modeling_mcp`
- `get_known_workspace_catalog`
- `execute_dax_query`
- `execute_dax_report_query`
- `execute_dax_dashboard_query` compatibility alias

## Install

```bash
npm install
npm run setup
npm run build
```

`npm run setup` asks for:

- Azure app display name
- Directory tenant ID/domain
- Application client ID
- Client secret value
- Microsoft `powerbi-modeling-mcp` command and args
- Known workspace names
- Default CEO workspace
- Optional default semantic model fallback
- Optional HTML report output folder

It writes a local `.env` file with mode `0600`. The MCP server loads this file automatically on start.

## Claude Desktop config

Use the built JS after `npm run build`.

For this machine, start from [`docs/claude-desktop-config.example.json`](docs/claude-desktop-config.example.json). It points the wrapper to the already installed Microsoft native binary:

```text
/Users/ducna/.codex/mcp/powerbi-modeling-mcp/node_modules/@microsoft/powerbi-modeling-mcp-darwin-arm64/dist/powerbi-modeling-mcp
```

Generic service-principal config:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-powerBI-to-report/dist/server.js"],
      "env": {
        "POWERBI_TENANT": "vnu.edu.vn",
        "POWERBI_CLIENT_ID": "<app-client-id>",
        "POWERBI_CLIENT_SECRET": "<client-secret-value>",
        "POWERBI_MODELING_MCP_COMMAND": "/absolute/path/to/powerbi-modeling-mcp",
        "POWERBI_MODELING_MCP_ARGS": "--start",
        "POWERBI_REPORT_OUTPUT_DIR": "/absolute/path/to/powerbi-report-output"
      }
    }
  }
}
```

For local development:

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

## Authentication

The server checks auth in this order:

1. `POWERBI_ACCESS_TOKEN`
2. service principal: `POWERBI_TENANT`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET`
3. cached delegated user token from `start_device_login` / `complete_device_login`

For production Claude usage, service principal is the most reliable option.

Power BI tenant/admin requirements:

- Enable **Allow service principals to use Power BI APIs**.
- Add the service principal to the relevant workspaces, or to an allowed security group.
- App/API permissions should allow workspace and dataset reads. In practice this normally means Power BI REST API application permissions such as `Workspace.Read.All` and `Dataset.Read.All`, with admin consent where required.
- **Power BI Remote MCP Preview** is a separate tenant setting for Microsoft's hosted remote MCP endpoint. It is not the same as allowing service principals to call Power BI APIs.

## Usage Examples

Ask Claude:

```text
Use mcp-powerBI-to-report to get the full catalog of workspaces and semantic models.
```

or:

```text
Use mcp-powerBI-to-report to list semantic models in workspace test-mcp via Microsoft Modeling MCP.
```

The second path works when the workspace name is already known and Microsoft `powerbi-modeling-mcp` can authenticate to XMLA.
If the workspace/model is not provided, Claude should call `get_catalog` first. If REST authentication is unavailable, Claude should ask the user for the workspace name instead of guessing.

For a CEO workflow, set:

```env
POWERBI_KNOWN_WORKSPACES=test-mcp
POWERBI_DEFAULT_WORKSPACE=test-mcp
# Optional fallback only. Prefer letting Claude choose from workspace schema.
# POWERBI_DEFAULT_SEMANTIC_MODEL=hospital
# Optional folder for generated HTML reports.
# POWERBI_REPORT_OUTPUT_DIR=/Users/ducna/powerbi-report-output
```

Then Claude can use `get_known_workspace_catalog` to list models from configured workspaces without REST auth, choose the relevant semantic model from schema/context, and call `execute_dax_report_query` for follow-up business questions. The wrapper keeps the Microsoft Modeling MCP process alive, so repeated questions reuse the same process and should reduce repeated login prompts.

`execute_dax_report_query` returns:

- concise text summary for chat
- `structuredContent` with rows, columns, and generated HTML
- embedded MCP `text/html` resource
- `reportPath` and `reportUri` for opening the generated local `.html` file

Use `execute_dax_query` only when raw query output is enough.

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
- ranked horizontal bar chart for the first text dimension and first numeric metric
- data table for returned rows
- question, workspace, semantic model, and DAX query context

Files are written to `POWERBI_REPORT_OUTPUT_DIR` when set, then `POWERBI_DASHBOARD_OUTPUT_DIR` for compatibility, otherwise `./powerbi-report-output` from the MCP process working directory.

The companion Power BI design reference repo is expected at:

```text
/Users/ducna/Power-BI-Design-Files
```

It is not vendored into this repo because it contains large `.pbix` and media files. Use it as visual inspiration while keeping this MCP package focused on generating lightweight HTML reports.

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

- `list_workspaces` uses `GET https://api.powerbi.com/v1.0/myorg/groups`.
- `list_semantic_models` uses `GET /datasets` for My workspace or `GET /groups/{groupId}/datasets` for a workspace.
- The Microsoft Modeling MCP bridge uses `npx -y @microsoft/powerbi-modeling-mcp@latest --start` by default. Override with `POWERBI_MODELING_MCP_COMMAND` and `POWERBI_MODELING_MCP_ARGS` if you have a signed local binary.
- Local verification notes are in [`docs/verification.md`](docs/verification.md).
