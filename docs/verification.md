# Verification

This server is a Claude-facing wrapper around Microsoft's official `powerbi-modeling-mcp`.

## What was verified locally

- MCP server starts over stdio and returns its tool list.
- `list_semantic_models_in_workspace_via_modeling_mcp` launches Microsoft's native `powerbi-modeling-mcp` binary.
- The Microsoft bridge can connect to workspace `test-mcp`.
- The Microsoft bridge returns semantic models `codex` and `hospital` from `test-mcp`.

## What requires tenant auth

The REST catalog tools require a valid Power BI REST credential:

- `list_workspaces`
- `list_semantic_models`
- `get_catalog`

Use one of:

- `POWERBI_ACCESS_TOKEN`
- `POWERBI_TENANT`, `POWERBI_CLIENT_ID`, `POWERBI_CLIENT_SECRET`
- `start_device_login` followed by `complete_device_login`

Service principal auth is the most stable setup for Claude Desktop because it avoids repeated delegated-user browser prompts.

Current local REST auth smoke result:

```text
authMode=user_cache
hasCachedToken=false
get_catalog=No Power BI token available
```

That means the server is ready for Claude, but tenant-wide workspace discovery will only work after a valid delegated token or service-principal credential is configured.
