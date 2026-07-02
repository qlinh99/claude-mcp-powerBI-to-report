param(
  [string]$Workspace = "GSM_MCP_POC_WORKSPACE",
  [string]$RepoDir = "$HOME\mcp-powerBI-to-report",
  [string]$ModelingMcpVersion = "0.5.0-beta.10",
  [switch]$CorporateNpm,
  [switch]$Clean,
  [switch]$SkipPrereqInstall
)

$ErrorActionPreference = "Stop"

function Command-Exists($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-NpmCommand {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npmCommand) {
    throw "npm is not available. Install Node.js LTS or ask IT to install Node.js LTS, then re-run this command."
  }
  return $npmCommand.Source
}

function Assert-NodeAndNpmVersion($NpmCommand) {
  $nodeVersionText = (& node -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "node failed." }
  $nodeMajor = [int](($nodeVersionText -replace '^v', '').Split('.')[0])
  if ($nodeMajor -lt 18) {
    throw "Node.js 18 or newer is required. Current: $nodeVersionText"
  }

  $npmVersionText = (& $NpmCommand -v).Trim()
  if ($LASTEXITCODE -ne 0) { throw "npm failed." }
  $npmMajor = [int]($npmVersionText.Split('.')[0])
  if ($npmMajor -lt 9) {
    throw "npm 9 or newer is required. Current: $npmVersionText at $NpmCommand"
  }
}

function Test-DirtyGitWorktree($Path) {
  $status = git -C $Path status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "git status failed in $Path"
  }
  return -not [string]::IsNullOrWhiteSpace(($status | Out-String))
}

function Resolve-LocalModelingCommand($RepoDir) {
  $nativeBinary = Join-Path $RepoDir "node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe"
  if (Test-Path $nativeBinary) {
    return @{
      Command = $nativeBinary
      Args = "--start --authmode=interactive"
      Source = "native-exe"
    }
  }

  $localShim = Join-Path $RepoDir "node_modules\.bin\powerbi-modeling-mcp.cmd"
  if (Test-Path $localShim) {
    return @{
      Command = $localShim
      Args = "--start --authmode=interactive"
      Source = "local-cmd-shim"
    }
  }

  $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  }
  if ($npxCommand) {
    return @{
      Command = $npxCommand.Source
      Args = "-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive"
      Source = "npx-fallback"
    }
  }

  throw "Cannot find a usable Modeling MCP command. Tried native .exe, local .cmd shim, and npx."
}

function Refresh-Path {
  $current = @(
    $env:Path -split ";" |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $machine = @(
    [System.Environment]::GetEnvironmentVariable("Path", "Machine") -split ";" |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $user = @(
    [System.Environment]::GetEnvironmentVariable("Path", "User") -split ";" |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $env:Path = (($current + $machine + $user) | Select-Object -Unique) -join ";"
}

function Try-WingetInstall($Id) {
  if ($SkipPrereqInstall) { return }
  if (-not (Command-Exists winget)) { return }
  winget install --id $Id -e --source winget
  Refresh-Path
}

if (-not (Command-Exists git)) {
  Write-Host "Git not found. Trying winget install..."
  Try-WingetInstall "Git.Git"
}
if (-not (Command-Exists node)) {
  Write-Host "Node.js not found. Trying winget install..."
  Try-WingetInstall "OpenJS.NodeJS.LTS"
}
Refresh-Path

if (-not (Command-Exists git)) {
  throw "Git is not available. Install Git or ask IT to install Git, then re-run this command."
}
if (-not (Command-Exists npm)) {
  throw "npm is not available. Install Node.js LTS or ask IT to install Node.js LTS, then re-run this command."
}
$NpmCommand = Resolve-NpmCommand
Assert-NodeAndNpmVersion $NpmCommand

if (!(Test-Path "$RepoDir\.git")) {
  git clone https://github.com/qlinh99/claude-mcp-powerBI-to-report.git $RepoDir
  if ($LASTEXITCODE -ne 0) {
    throw "git clone failed."
  }
} else {
  if (Test-DirtyGitWorktree $RepoDir) {
    throw "Existing repo has local changes. Use the explicit local repo command in README instead of this installer."
  }
  Set-Location $RepoDir
  git pull
  if ($LASTEXITCODE -ne 0) {
    throw "git pull failed. Resolve local changes or use the explicit local repo command."
  }
}

Set-Location $RepoDir

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($Clean -or $CorporateNpm) {
  if (Test-Path .\node_modules) {
    try {
      Remove-Item -Recurse -Force .\node_modules -ErrorAction Stop
    } catch {
      $backup = "node_modules.bak.$(Get-Date -Format yyyyMMddHHmmss)"
      Write-Host "Could not fully remove node_modules. Trying to rename it to $backup ..."
      Rename-Item .\node_modules $backup -ErrorAction Stop
    }
  }
}

try {
  if ($CorporateNpm) {
    $env:npm_config_strict_ssl = "false"
    & $NpmCommand cache clean --force
    if ($LASTEXITCODE -ne 0) {
      throw "npm cache clean failed."
    }
  }

  & $NpmCommand install --omit=dev --include=optional
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }

  $nativeModelingBinary = Join-Path $RepoDir "node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe"
  if (-not (Test-Path $nativeModelingBinary)) {
    Write-Host "Microsoft Modeling MCP native Windows binary is missing. Trying explicit native package install..."
    & $NpmCommand install --omit=dev --include=optional --no-save "@microsoft/powerbi-modeling-mcp-win32-x64@$ModelingMcpVersion"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Explicit native package install failed. Will try local .cmd shim or npx fallback."
    }
  }
}
finally {
  if ($CorporateNpm) {
    Remove-Item Env:npm_config_strict_ssl -ErrorAction SilentlyContinue
  }
}

$resolvedModeling = Resolve-LocalModelingCommand $RepoDir
$resolvedNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $resolvedNode) {
  $resolvedNode = Get-Command node -ErrorAction Stop
}

& powershell -ExecutionPolicy Bypass -File .\scripts\setup-claude-desktop.ps1 `
  -Workspace $Workspace `
  -NodeCommand $resolvedNode.Source `
  -ModelingCommand $resolvedModeling.Command `
  -ModelingArgs $resolvedModeling.Args `
  -SkipInstall
if ($LASTEXITCODE -ne 0) {
  throw "Claude Desktop MCP setup failed with exit code $LASTEXITCODE."
}

$envPath = Join-Path $RepoDir ".env"
$serverJs = Join-Path $RepoDir "dist\server.js"
if (-not (Test-Path $serverJs)) {
  throw "Missing prebuilt server after install: $serverJs"
}
if (-not (Test-Path $envPath)) {
  throw "Missing .env after setup: $envPath"
}

Write-Host ""
Write-Host "Done. Modeling command source: $($resolvedModeling.Source)"
Write-Host "Start Claude Desktop again, then ask Claude:"
Write-Host "Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup."
