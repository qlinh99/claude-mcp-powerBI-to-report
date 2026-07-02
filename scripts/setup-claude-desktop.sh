#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Setup mcp-powerBI-to-report for Claude Desktop.

Usage:
  bash scripts/setup-claude-desktop.sh [options]

Options:
  --workspace <name>          Default workspace and known workspace for a single-workspace setup
  --workspaces <csv>          Known Power BI/Fabric workspaces. Default: POWERBI_KNOWN_WORKSPACES or test-mcp
  --model <name>              Optional default semantic model fallback. Default: POWERBI_DEFAULT_SEMANTIC_MODEL
  --report-dir <path>         HTML report output folder. Default: ~/powerbi-report-output
  --config <path>             Claude Desktop config path override
  --name <name>               MCP server name in Claude Desktop. Default: mcp-powerBI-to-report
  --modeling-command <path>   Microsoft Power BI Modeling MCP command override
  --modeling-args <args>      Microsoft Power BI Modeling MCP args. Default: --start --authmode=interactive
  --skip-install              Skip npm install
  --dry-run                   Print detected values without writing files
  -h, --help                  Show this help

Examples:
  bash scripts/setup-claude-desktop.sh --workspace test-mcp
  curl -fsSL https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace test-mcp
EOF
}

repo_url="https://github.com/qlinh99/claude-mcp-powerBI-to-report.git"
script_source="${BASH_SOURCE[0]:-}"
if [[ -n "$script_source" && -f "$script_source" && "$script_source" != /dev/fd/* ]]; then
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  repo_dir="$(cd "$script_dir/.." && pwd)"
else
  repo_dir="${MCP_POWERBI_TO_REPORT_DIR:-$HOME/mcp-powerBI-to-report}"
  if [[ ! -d "$repo_dir/.git" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "Missing required command: git" >&2
      exit 1
    fi
    git clone "$repo_url" "$repo_dir"
  fi
  script_dir="$repo_dir/scripts"
fi
mcp_name="mcp-powerBI-to-report"
known_workspaces="${POWERBI_KNOWN_WORKSPACES:-test-mcp}"
default_workspace="${POWERBI_DEFAULT_WORKSPACE:-}"
default_semantic_model="${POWERBI_DEFAULT_SEMANTIC_MODEL:-}"
report_dir="${POWERBI_REPORT_OUTPUT_DIR:-}"
config_path=""
modeling_command="${POWERBI_MODELING_MCP_COMMAND:-}"
modeling_args="${POWERBI_MODELING_MCP_ARGS:-}"
skip_install=0
dry_run=0
known_workspaces_explicit=0
default_workspace_explicit=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspaces)
      known_workspaces="${2:?Missing value for --workspaces}"
      known_workspaces_explicit=1
      shift 2
      ;;
    --workspace)
      default_workspace="${2:?Missing value for --workspace}"
      default_workspace_explicit=1
      shift 2
      ;;
    --model)
      default_semantic_model="${2:?Missing value for --model}"
      shift 2
      ;;
    --report-dir)
      report_dir="${2:?Missing value for --report-dir}"
      shift 2
      ;;
    --config)
      config_path="${2:?Missing value for --config}"
      shift 2
      ;;
    --name)
      mcp_name="${2:?Missing value for --name}"
      shift 2
      ;;
    --modeling-command)
      modeling_command="${2:?Missing value for --modeling-command}"
      shift 2
      ;;
    --modeling-args)
      modeling_args="${2:?Missing value for --modeling-args}"
      shift 2
      ;;
    --skip-install)
      skip_install=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$default_workspace_explicit" -eq 1 && "$known_workspaces_explicit" -eq 0 ]]; then
  known_workspaces="$default_workspace"
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

command_source() {
  command -v "$1"
}

assert_node_and_npm_version() {
  local node_version node_major npm_version npm_major
  node_version="$(node -v)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [[ "$node_major" -lt 18 ]]; then
    echo "Node.js 18 or newer is required. Current: $node_version" >&2
    exit 1
  fi

  npm_version="$(npm -v)"
  npm_major="${npm_version%%.*}"
  if [[ "$npm_major" -lt 9 ]]; then
    echo "npm 9 or newer is required. Current: $npm_version" >&2
    exit 1
  fi
}

trim_csv_first() {
  local value="$1"
  value="${value%%,*}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) printf '%s' "macos" ;;
    MINGW*|MSYS*|CYGWIN*) printf '%s' "windows" ;;
    Linux)
      if [[ -r /proc/version ]] && grep -qi microsoft /proc/version; then
        printf '%s' "windows"
      else
        printf '%s' "linux"
      fi
      ;;
    *) printf '%s' "unknown" ;;
  esac
}

to_unix_path() {
  local value="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$value"
  elif command -v wslpath >/dev/null 2>&1; then
    wslpath -u "$value"
  else
    printf '%s' "$value"
  fi
}

to_claude_path() {
  local value="$1"
  if [[ "$os_id" == "windows" ]]; then
    if command -v cygpath >/dev/null 2>&1; then
      cygpath -w "$value"
    elif command -v wslpath >/dev/null 2>&1; then
      wslpath -w "$value"
    else
      printf '%s' "$value"
    fi
  else
    printf '%s' "$value"
  fi
}

windows_env_path() {
  local name="$1"
  local value="${!name:-}"
  if [[ -n "$value" ]]; then
    to_unix_path "$value"
    return
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    case "$name" in
      APPDATA)
        powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('ApplicationData')" | tr -d '\r'
        ;;
      LOCALAPPDATA)
        powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('LocalApplicationData')" | tr -d '\r'
        ;;
    esac | while IFS= read -r line; do to_unix_path "$line"; done
  fi
}

default_claude_config_path() {
  if [[ "$os_id" == "macos" ]]; then
    printf '%s' "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    return
  fi

  if [[ "$os_id" == "windows" ]]; then
    local appdata localappdata standard msix
    appdata="$(windows_env_path APPDATA || true)"
    localappdata="$(windows_env_path LOCALAPPDATA || true)"
    standard=""
    if [[ -n "$appdata" ]]; then
      standard="$appdata/Claude/claude_desktop_config.json"
    fi
    if [[ -n "$localappdata" && -d "$localappdata/Packages" ]]; then
      msix="$(find "$localappdata/Packages" -maxdepth 1 -type d -name 'Claude_*' -print -quit 2>/dev/null || true)"
      if [[ -n "$msix" && -f "$msix/LocalCache/Roaming/Claude/claude_desktop_config.json" ]]; then
        printf '%s' "$msix/LocalCache/Roaming/Claude/claude_desktop_config.json"
        return
      fi
    fi
    if [[ -n "$standard" ]]; then
      printf '%s' "$standard"
      return
    fi
  fi

  echo "Cannot auto-detect Claude Desktop config path for OS: $os_id. Use --config." >&2
  exit 1
}

native_modeling_binary() {
  local arch package binary
  arch="$(uname -m)"
  case "$os_id:$arch" in
    macos:arm64|macos:aarch64)
      package="@microsoft/powerbi-modeling-mcp-darwin-arm64"
      binary="powerbi-modeling-mcp"
      ;;
    macos:x86_64|macos:amd64)
      package="@microsoft/powerbi-modeling-mcp-darwin-x64"
      binary="powerbi-modeling-mcp"
      ;;
    windows:*)
      package="@microsoft/powerbi-modeling-mcp-win32-x64"
      binary="powerbi-modeling-mcp.exe"
      ;;
    *)
      return 1
      ;;
  esac
  printf '%s' "$repo_dir/node_modules/$package/dist/$binary"
}

require_command node
require_command npm
assert_node_and_npm_version
node_command="$(command_source node)"

os_id="$(detect_os)"
if [[ -z "$default_workspace" ]]; then
  default_workspace="$(trim_csv_first "$known_workspaces")"
fi
if [[ -z "$report_dir" ]]; then
  report_dir="$HOME/powerbi-report-output"
fi
if [[ -z "$config_path" ]]; then
  config_path="$(default_claude_config_path)"
fi

cd "$repo_dir"
if [[ "$skip_install" -eq 0 && "$dry_run" -eq 0 ]]; then
  npm install --omit=dev --include=optional
fi

native_binary=""
if native_binary="$(native_modeling_binary 2>/dev/null)"; then
  :
else
  native_binary=""
fi

if [[ -z "$modeling_command" ]]; then
  if [[ -n "$native_binary" && -x "$native_binary" ]]; then
    modeling_command="$native_binary"
  elif [[ "$os_id" == "windows" ]]; then
    echo "Cannot find Windows Microsoft Modeling MCP binary at: $native_binary" >&2
    echo "Run npm install --omit=dev --include=optional from this repo in Git Bash, then re-run this script." >&2
    exit 1
  else
    modeling_command="npx"
  fi
fi
if [[ -z "$modeling_args" ]]; then
  if [[ "$modeling_command" == "npx" ]]; then
    modeling_args="-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive"
  else
    modeling_args="--start --authmode=interactive"
  fi
fi

server_js="$repo_dir/dist/server.js"
env_path="$repo_dir/.env"
report_dir_unix="$report_dir"
config_path_unix="$config_path"
if [[ "$os_id" == "windows" ]]; then
  report_dir_unix="$(to_unix_path "$report_dir")"
  config_path_unix="$(to_unix_path "$config_path")"
fi

server_js_for_claude="$(to_claude_path "$server_js")"
node_command_for_claude="$node_command"
modeling_command_for_claude="$modeling_command"
report_dir_for_claude="$report_dir"
if [[ "$os_id" == "windows" ]]; then
  node_command_for_claude="$(to_claude_path "$node_command")"
  modeling_command_for_claude="$(to_claude_path "$modeling_command")"
  report_dir_for_claude="$(to_claude_path "$report_dir_unix")"
fi

if [[ "$dry_run" -eq 1 ]]; then
  cat <<EOF
Detected OS: $os_id
Repo: $repo_dir
Claude config: $config_path_unix
Node command: $node_command_for_claude
Server JS: $server_js_for_claude
Modeling command: $modeling_command_for_claude
Modeling args: $modeling_args
Known workspaces: $known_workspaces
Default workspace: $default_workspace
Default semantic model: $default_semantic_model
Report dir: $report_dir_for_claude
EOF
  exit 0
fi

if [[ ! -f "$server_js" ]]; then
  echo "Missing prebuilt server: $server_js" >&2
  echo "Use the GitHub main branch that includes dist/server.js, or run npm install && npm run build on a development machine." >&2
  exit 1
fi
mkdir -p "$report_dir_unix"
mkdir -p "$(dirname "$config_path_unix")"

if [[ -f "$config_path_unix" ]]; then
  cp "$config_path_unix" "$config_path_unix.bak.$(date +%Y%m%d%H%M%S)"
fi

CONFIG_PATH="$config_path_unix" \
ENV_PATH="$env_path" \
MCP_NAME="$mcp_name" \
NODE_COMMAND="$node_command_for_claude" \
SERVER_JS="$server_js_for_claude" \
KNOWN_WORKSPACES="$known_workspaces" \
DEFAULT_WORKSPACE="$default_workspace" \
DEFAULT_SEMANTIC_MODEL="$default_semantic_model" \
MODELING_COMMAND="$modeling_command_for_claude" \
MODELING_ARGS="$modeling_args" \
REPORT_DIR="$report_dir_for_claude" \
"$node_command" --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const configPath = process.env.CONFIG_PATH;
const envPath = process.env.ENV_PATH;
const serverName = process.env.MCP_NAME;
const env = {
  POWERBI_KNOWN_WORKSPACES: process.env.KNOWN_WORKSPACES || "",
  POWERBI_DEFAULT_WORKSPACE: process.env.DEFAULT_WORKSPACE || "",
  POWERBI_MODELING_MCP_COMMAND: process.env.MODELING_COMMAND || "",
  POWERBI_MODELING_MCP_ARGS: process.env.MODELING_ARGS || "",
  POWERBI_REPORT_OUTPUT_DIR: process.env.REPORT_DIR || ""
};
if (process.env.DEFAULT_SEMANTIC_MODEL) {
  env.POWERBI_DEFAULT_SEMANTIC_MODEL = process.env.DEFAULT_SEMANTIC_MODEL;
}

let config = {};
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, "utf8").trim();
  if (raw) config = JSON.parse(raw);
}
if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
  config.mcpServers = {};
}
config.mcpServers[serverName] = {
  command: process.env.NODE_COMMAND,
  args: [process.env.SERVER_JS],
  env
};

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

const envLines = [
  "# Generated by scripts/setup-claude-desktop.sh",
  ...Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
  ""
];
writeFileSync(envPath, envLines.join("\n"), { mode: 0o600 });
chmodSync(envPath, 0o600);
NODE

echo "Claude Desktop config updated: $config_path_unix"
echo "Local env written: $env_path"
echo "Restart Claude Desktop completely, then use MCP server: $mcp_name"
