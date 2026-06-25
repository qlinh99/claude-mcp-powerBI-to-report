#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AuthManager } from "./auth.js";
import { ModelingMcpBridge } from "./modelingMcpBridge.js";
import { PowerBiClient } from "./powerbiClient.js";

const auth = new AuthManager();
const powerbi = new PowerBiClient(auth);

const server = new McpServer({
  name: "mcp-powerbi",
  version: "0.1.0"
});

server.registerTool(
  "auth_status",
  {
    title: "Power BI auth status",
    description: "Show which Power BI authentication mode is configured without exposing tokens.",
    inputSchema: {}
  },
  async () => jsonResult(await auth.status())
);

server.registerTool(
  "start_device_login",
  {
    title: "Start Power BI device login",
    description: "Start delegated user device-code login for Power BI REST API. Use only for one-time local setup; service principal is recommended for production.",
    inputSchema: {}
  },
  async () => jsonResult(await auth.startDeviceLogin())
);

server.registerTool(
  "complete_device_login",
  {
    title: "Complete Power BI device login",
    description: "Poll Microsoft for the pending device-code login and cache the token when authorization is complete.",
    inputSchema: {}
  },
  async () => jsonResult(await auth.completeDeviceLogin())
);

server.registerTool(
  "list_workspaces",
  {
    title: "List Power BI/Fabric workspaces",
    description: "List all Fabric/Power BI workspaces visible to the authenticated account through the Power BI REST API. Use this first when the user does not provide a workspace name or id.",
    inputSchema: {
      includeMyWorkspace: z.boolean().optional().default(true).describe("Include the personal 'My workspace' pseudo-workspace.")
    }
  },
  async ({ includeMyWorkspace }) => jsonResult(await powerbi.listWorkspaces(includeMyWorkspace))
);

server.registerTool(
  "list_semantic_models",
  {
    title: "List semantic models",
    description: "List semantic models in My workspace or in a specific workspace by id. Use list_workspaces first to resolve workspace ids. If workspace discovery is not authenticated and the user did not name a workspace, ask the user which workspace to use.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace/group id. Omit for My workspace.")
    }
  },
  async ({ workspaceId }) => jsonResult(await powerbi.listSemanticModels(workspaceId ?? null))
);

server.registerTool(
  "get_catalog",
  {
    title: "Get workspace and semantic model catalog",
    description: "Return all visible workspaces and semantic models via Power BI REST API. This is the preferred tool for open-ended questions such as 'which model should I use?' or 'what workspaces can I access?'.",
    inputSchema: {
      includeMyWorkspace: z.boolean().optional().default(true).describe("Include My workspace datasets.")
    }
  },
  async ({ includeMyWorkspace }) => jsonResult(await powerbi.getCatalog(includeMyWorkspace))
);

server.registerTool(
  "list_semantic_models_in_workspace_via_modeling_mcp",
  {
    title: "List semantic models in known workspace via Microsoft Modeling MCP",
    description: "Use Microsoft powerbi-modeling-mcp/XMLA auth to list semantic models inside a known workspace name. This is a fallback when REST workspace discovery auth is unavailable. The workspace name must be explicit; if it is missing, ask the user instead of guessing.",
    inputSchema: {
      workspaceName: z.string().describe("Exact Fabric/Power BI workspace name, for example 'test-mcp'.")
    }
  },
  async ({ workspaceName }) => {
    const bridge = new ModelingMcpBridge();
    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName,
      semanticModels: await bridge.listSemanticModelsInWorkspace(workspaceName)
    });
  }
);

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
