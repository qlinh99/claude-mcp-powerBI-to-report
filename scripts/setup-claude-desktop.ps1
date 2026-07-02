param(
  [string]$Workspaces = $env:POWERBI_KNOWN_WORKSPACES,
  [string]$Workspace = $env:POWERBI_DEFAULT_WORKSPACE,
  [string]$Model = $env:POWERBI_DEFAULT_SEMANTIC_MODEL,
  [string]$ReportDir = $env:POWERBI_REPORT_OUTPUT_DIR,
  [string]$Config = "",
  [string]$Name = "mcp-powerBI-to-report",
  [string]$NodeCommand = "",
  [string]$ModelingCommand = $env:POWERBI_MODELING_MCP_COMMAND,
  [string]$ModelingArgs = $env:POWERBI_MODELING_MCP_ARGS,
  [switch]$SkipInstall,
  [switch]$DryRun,
  [switch]$NoStopClaude
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Resolve-NodeCommand($RequestedCommand) {
  if ($RequestedCommand) {
    if (-not (Test-Path $RequestedCommand) -and -not (Get-Command $RequestedCommand -ErrorAction SilentlyContinue)) {
      throw "Configured Node command was not found: $RequestedCommand"
    }
    if (Test-Path $RequestedCommand) {
      return $RequestedCommand
    }
    return (Get-Command $RequestedCommand -ErrorAction Stop).Source
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $nodeCommand) {
    throw "Node.js 18+ is required but node was not found on PATH"
  }
  return $nodeCommand.Source
}

function Resolve-NpmCommand {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npmCommand) {
    throw "npm 9+ is required but npm was not found on PATH"
  }
  return $npmCommand.Source
}

function Assert-NodeAndNpmVersion($ResolvedNodeCommand, $ResolvedNpmCommand) {
  $nodeVersionText = (& $ResolvedNodeCommand -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "node failed." }
  $nodeMajor = [int](($nodeVersionText -replace '^v', '').Split('.')[0])
  if ($nodeMajor -lt 18) {
    throw "Node.js 18 or newer is required. Current: $nodeVersionText at $ResolvedNodeCommand"
  }

  $npmVersionText = (& $ResolvedNpmCommand -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "npm failed." }
  $npmMajor = [int]($npmVersionText.Split('.')[0])
  if ($npmMajor -lt 9) {
    throw "npm 9 or newer is required. Current: $npmVersionText at $ResolvedNpmCommand"
  }
}

function First-CsvValue($Value) {
  if (-not $Value) { return "" }
  return (($Value -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
}

function Get-ClaudeConfigPath {
  if ($Config) { return $Config }

  $standard = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  $packages = Join-Path $env:LOCALAPPDATA "Packages"
  if (Test-Path $packages) {
    $msix = Get-ChildItem $packages -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($msix) {
      $candidate = Join-Path $msix.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"
      if (Test-Path $candidate) { return $candidate }
    }
  }
  return $standard
}

function Stop-ClaudeDesktop {
  $processes = @()
  foreach ($name in @("Claude", "claude")) {
    $processes += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }
  $processes = @($processes | Sort-Object -Property Id -Unique)
  if ($processes.Count -gt 0) {
    Write-Host "Stopping Claude Desktop before editing config..."
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
}

function Read-JsonObjectFromFile($Path) {
  $raw = (Get-Content $Path -Raw).Trim()
  if (-not $raw) {
    return [pscustomobject]@{}
  }
  $parsed = $raw | ConvertFrom-Json
  if (-not $parsed -or $parsed -is [array] -or $parsed -isnot [pscustomobject]) {
    return [pscustomobject]@{}
  }
  return $parsed
}

function Read-ClaudeConfigWithRecovery($Path) {
  if (-not (Test-Path $Path)) {
    return [pscustomobject]@{}
  }

  $backupPath = "$Path.bak.$(Get-Date -Format yyyyMMddHHmmssfff)"
  Copy-Item $Path $backupPath -Force

  try {
    return Read-JsonObjectFromFile $Path
  } catch {
    Write-Host "Existing Claude config is invalid JSON. Trying latest valid backup..."
  }

  $backupPattern = "$(Split-Path -Leaf $Path).bak.*"
  $backupDir = Split-Path -Parent $Path
  $backups = Get-ChildItem $backupDir -File -Filter $backupPattern -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending

  foreach ($backup in $backups) {
    try {
      Write-Host "Recovered Claude config from backup: $($backup.FullName)"
      return Read-JsonObjectFromFile $backup.FullName
    } catch {
      continue
    }
  }

  Write-Host "No valid Claude config backup found. Creating a new config object."
  return [pscustomobject]@{}
}

function Write-JsonAtomic($Path, $Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $tempPath = Join-Path $directory ("$(Split-Path -Leaf $Path).tmp.$PID.$(Get-Date -Format yyyyMMddHHmmssfff)")
  $json = $Value | ConvertTo-Json -Depth 20
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  try {
    [System.IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, $utf8NoBom)
    (Get-Content $tempPath -Raw | ConvertFrom-Json) | Out-Null
    if (Test-Path $Path) {
      [System.IO.File]::Replace($tempPath, $Path, $null)
    } else {
      [System.IO.File]::Move($tempPath, $Path)
    }
    (Get-Content $Path -Raw | ConvertFrom-Json) | Out-Null
  } finally {
    if (Test-Path $tempPath) {
      Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Resolve-ModelingCommand($RepoDir, $RequestedCommand) {
  if ($RequestedCommand) {
    if ($RequestedCommand -match '(^|\\)npx(\.cmd)?$' -or $RequestedCommand -eq 'npx' -or $RequestedCommand -eq 'npx.cmd') {
      $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
      if (-not $npxCommand) {
        $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
      }
      if (-not $npxCommand) {
        throw "Cannot find npx or npx.cmd on PATH."
      }
      return $npxCommand.Source
    }
    if (-not (Test-Path $RequestedCommand) -and -not (Get-Command $RequestedCommand -ErrorAction SilentlyContinue)) {
      throw "Configured POWERBI_MODELING_MCP_COMMAND was not found: $RequestedCommand"
    }
    return $RequestedCommand
  }

  $nativeBinary = Join-Path $RepoDir "node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe"
  if (Test-Path $nativeBinary) {
    return $nativeBinary
  }

  $localShim = Join-Path $RepoDir "node_modules\.bin\powerbi-modeling-mcp.cmd"
  if (Test-Path $localShim) {
    return $localShim
  }

  $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  }
  if ($npxCommand) {
    return $npxCommand.Source
  }

  throw "Cannot find a usable Modeling MCP command. Tried native .exe, local .cmd shim, and npx."
}

$NodeCommand = Resolve-NodeCommand $NodeCommand
$NpmCommand = Resolve-NpmCommand
Assert-NodeAndNpmVersion $NodeCommand $NpmCommand

$RepoDir = Split-Path -Parent $PSScriptRoot
if (-not $Workspaces -and $Workspace) {
  $Workspaces = $Workspace
}
if (-not $Workspaces) { $Workspaces = "test-mcp" }
if (-not $Workspace) { $Workspace = First-CsvValue $Workspaces }
if (-not $ReportDir) { $ReportDir = Join-Path $HOME "powerbi-report-output" }
if (-not $ModelingArgs) { $ModelingArgs = "--start --authmode=interactive" }

Set-Location $RepoDir

if (-not $SkipInstall -and -not $DryRun) {
  & $NpmCommand install --omit=dev --include=optional
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
}

$ModelingCommand = Resolve-ModelingCommand $RepoDir $ModelingCommand
if ($ModelingCommand.ToLower().EndsWith("npx.cmd") -or $ModelingCommand -eq "npx") {
  if (-not $env:POWERBI_MODELING_MCP_ARGS -and -not $PSBoundParameters.ContainsKey("ModelingArgs")) {
    $ModelingArgs = "-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive"
  }
}

$ConfigPath = Get-ClaudeConfigPath
$ServerJs = Join-Path $RepoDir "dist\server.js"

if ($DryRun) {
  [ordered]@{
    Repo = $RepoDir
    ClaudeConfig = $ConfigPath
    NodeCommand = $NodeCommand
    NpmCommand = $NpmCommand
    ServerJs = $ServerJs
    ModelingCommand = $ModelingCommand
    ModelingArgs = $ModelingArgs
    KnownWorkspaces = $Workspaces
    DefaultWorkspace = $Workspace
    DefaultSemanticModel = $Model
    ReportDir = $ReportDir
  } | Format-List
  exit 0
}

if (-not (Test-Path $ServerJs)) {
  throw "Missing prebuilt server: $ServerJs. Use the GitHub main branch that includes dist/server.js, or run npm install && npm run build on a development machine."
}
if (-not $NoStopClaude) {
  Stop-ClaudeDesktop
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null

$configObject = Read-ClaudeConfigWithRecovery $ConfigPath

$configMap = @{}
foreach ($property in $configObject.PSObject.Properties) {
  $configMap[$property.Name] = $property.Value
}
if (-not $configMap.ContainsKey("mcpServers") -or -not $configMap["mcpServers"]) {
  $configMap["mcpServers"] = [pscustomobject]@{}
}

$mcpServers = @{}
foreach ($property in $configMap["mcpServers"].PSObject.Properties) {
  $mcpServers[$property.Name] = $property.Value
}

$envMap = [ordered]@{
  POWERBI_KNOWN_WORKSPACES = $Workspaces
  POWERBI_DEFAULT_WORKSPACE = $Workspace
  POWERBI_MODELING_MCP_COMMAND = $ModelingCommand
  POWERBI_MODELING_MCP_ARGS = $ModelingArgs
  POWERBI_REPORT_OUTPUT_DIR = $ReportDir
}
if ($Model) {
  $envMap["POWERBI_DEFAULT_SEMANTIC_MODEL"] = $Model
}

$mcpServers[$Name] = [ordered]@{
  command = $NodeCommand
  args = @($ServerJs)
  env = $envMap
}
$configMap["mcpServers"] = $mcpServers

Write-JsonAtomic $ConfigPath $configMap

$envPath = Join-Path $RepoDir ".env"
$envLines = @("# Generated by scripts/setup-claude-desktop.ps1")
foreach ($item in $envMap.GetEnumerator()) {
  $jsonValue = $item.Value | ConvertTo-Json -Compress
  $envLines += "$($item.Key)=$jsonValue"
}
$envLines += ""
$envLines | Set-Content -Path $envPath -Encoding UTF8

if (-not (Test-Path $envPath)) {
  throw "Failed to write .env file: $envPath"
}

Write-Host "Claude Desktop config updated: $ConfigPath"
Write-Host "Local env written: $envPath"
Write-Host "Start Claude Desktop again, then use MCP server: $Name"
