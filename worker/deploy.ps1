# deploy.ps1 - one-shot deploy of the Google Health MCP worker to Cloudflare.
#
# Prerequisites (once):
#   * npx wrangler login                      (opens a browser; free Cloudflare account)
#   * ..\.env with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the Google Cloud console
# Then:
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# What it does:
#   1. creates the TOKENS KV namespace on first run and writes its id into wrangler.jsonc
#   2. deploys the worker and reads back its https://*.workers.dev URL
#   3. uploads the secrets (Google client id/secret from ..\.env, plus a random ACCESS_KEY)
#   4. writes deploy-output.json (URL, key, connector URL, login URL, callback URL)
#   5. repoints Claude Code at the remote server
#
# The worker builds its links from the origin each request arrives on, so the worker URL is
# never written into wrangler.jsonc (it stays free of account-specific hostnames).
$ErrorActionPreference = "Stop"
# Native commands run via cmd /c with 2>&1 inside cmd: PowerShell 5.1 would otherwise turn
# harmless stderr lines (e.g. "npm notice") into terminating errors under Stop.
Set-Location $PSScriptRoot
$root = Split-Path $PSScriptRoot -Parent

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

function Find-Python {
    foreach ($candidate in @((Join-Path $root ".venv\Scripts\python.exe"), "python", "py")) {
        try {
            $v = (cmd /c "`"$candidate`" --version 2>&1") | Out-String
            if ($LASTEXITCODE -eq 0 -and $v -match "Python 3") { return $candidate }
        } catch {}
    }
    return $null
}

# ---- 0. logged in? ---------------------------------------------------------
Step "Checking wrangler login"
$who = (cmd /c "npx wrangler whoami 2>&1") | Out-String
if ($who -notmatch "logged in") {
    Write-Host $who
    Write-Host "Not logged in to Cloudflare. Run:  npx wrangler login   (opens a browser), then re-run this script." -ForegroundColor Yellow
    exit 1
}
Write-Host ($who.Trim().Split("`n") | Where-Object { $_ -match "logged in" } | Select-Object -First 1)

# ---- 0b. credentials present? ---------------------------------------------
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw "Missing $envFile - copy .env.example to .env and fill in the Google OAuth client id/secret." }
$envMap = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $envMap[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
}
if (-not $envMap["GOOGLE_CLIENT_ID"] -or -not $envMap["GOOGLE_CLIENT_SECRET"]) {
    throw "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from $envFile"
}
if ($envMap["GOOGLE_CLIENT_ID"] -notmatch "\.apps\.googleusercontent\.com$") {
    Write-Host "Warning: GOOGLE_CLIENT_ID does not look like a Google OAuth client id (expected *.apps.googleusercontent.com)." -ForegroundColor Yellow
}

# ---- 1. KV namespace -------------------------------------------------------
$cfgPath = Join-Path $PSScriptRoot "wrangler.jsonc"
$cfg = Get-Content $cfgPath -Raw
if ($cfg -match "REPLACE_WITH_KV_ID") {
    # The title is account-wide, so give it a project prefix (the Withings worker owns plain "TOKENS").
    $kvTitle = "googlehealth-TOKENS"
    Step "Looking up KV namespace $kvTitle"
    $kvId = $null
    $list = (cmd /c "npx wrangler kv namespace list 2>&1") | Out-String
    $a = $list.IndexOf("["); $b = $list.LastIndexOf("]")
    if ($a -ge 0 -and $b -gt $a) {
        try {
            foreach ($ns in ($list.Substring($a, $b - $a + 1) | ConvertFrom-Json)) {
                if ($ns.title -eq $kvTitle) { $kvId = $ns.id }
            }
        } catch {}
    }
    if ($kvId) {
        Write-Host "Reusing existing namespace $kvTitle ($kvId)"
    } else {
        Step "Creating KV namespace $kvTitle"
        $out = (cmd /c "npx wrangler kv namespace create $kvTitle 2>&1") | Out-String
        if ($out -match '"id":\s*"([0-9a-f]{32})"') {
            $kvId = $Matches[1]
        } elseif ($out -match 'id\s*=\s*"([0-9a-f]{32})"') {
            $kvId = $Matches[1]
        } else {
            Write-Host $out
            throw "Could not find the KV namespace id in wrangler's output."
        }
    }
    $cfg = $cfg -replace "REPLACE_WITH_KV_ID", $kvId
    [System.IO.File]::WriteAllText($cfgPath, $cfg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "KV namespace id: $kvId"
} else {
    Write-Host "KV namespace already configured."
}

# ---- 2. deploy -------------------------------------------------------------
Step "Deploying worker"
$deploy = (cmd /c "npx wrangler deploy 2>&1") | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $deploy; throw "wrangler deploy failed" }
Write-Host $deploy
if ($deploy -match 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev') {
    $url = $Matches[0]
} else {
    throw "Could not find the workers.dev URL in the deploy output above."
}
Write-Host "Worker URL: $url"

# ---- 3. secrets ------------------------------------------------------------
Step "Uploading secrets"
$outFile = Join-Path $PSScriptRoot "deploy-output.json"
$accessKey = $null
if (Test-Path $outFile) {
    try { $accessKey = (Get-Content $outFile -Raw | ConvertFrom-Json).access_key } catch { $accessKey = $null }
}
if (-not $accessKey) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $accessKey = ([Convert]::ToBase64String($bytes)) -replace '\+', '-' -replace '/', '_' -replace '=', ''
}
$secrets = @(
    @("GOOGLE_CLIENT_ID", $envMap["GOOGLE_CLIENT_ID"]),
    @("GOOGLE_CLIENT_SECRET", $envMap["GOOGLE_CLIENT_SECRET"]),
    @("ACCESS_KEY", $accessKey)
)
foreach ($s in $secrets) {
    $name = $s[0]; $value = $s[1]
    $tmp = Join-Path $env:TEMP ("wr-secret-" + [guid]::NewGuid().ToString("n"))
    [System.IO.File]::WriteAllText($tmp, $value, (New-Object System.Text.UTF8Encoding $false))
    try {
        $r = (cmd /c "npx wrangler secret put $name < `"$tmp`" 2>&1") | Out-String
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) { Write-Host $r; throw "wrangler secret put $name failed" }
    Write-Host "  set $name"
}

# ---- 4. record outputs -----------------------------------------------------
$mcpUrl = "$url/mcp/$accessKey"
$loginUrl = "$url/auth/$accessKey"
$callbackUrl = "$url/callback"
@{
    url = $url; access_key = $accessKey; mcp_url = $mcpUrl
    login_url = $loginUrl; callback_url = $callbackUrl
    deployed_at = (Get-Date).ToString("s")
} | ConvertTo-Json | Set-Content $outFile -Encoding utf8

# ---- 5. repoint Claude Code ------------------------------------------------
Step "Pointing Claude Code at the remote server (a backup is written next to the config)"
$py = Find-Python
if ($py) {
    $upd = Join-Path $PSScriptRoot "update_claude_configs.py"
    $r = (cmd /c "`"$py`" `"$upd`" $mcpUrl 2>&1") | Out-String
    Write-Host $r
    if ($LASTEXITCODE -ne 0) { throw "updating Claude configs failed" }
} else {
    Write-Host "  python not found; add this to ~/.claude.json mcpServers by hand:" -ForegroundColor Yellow
    Write-Host "  `"googlehealth`": { `"type`": `"http`", `"url`": `"$mcpUrl`" }"
}

# ---- done ------------------------------------------------------------------
Write-Host ""
Write-Host "================ DONE ================" -ForegroundColor Green
Write-Host "MCP connector URL (keep it private, it is your key):"
Write-Host "  $mcpUrl" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Google Cloud console > APIs & Services > Credentials > your OAuth client > Authorized redirect URIs:"
Write-Host "     add  $callbackUrl   and save."
Write-Host "  2. Log in once (opens the Google consent page; tick every permission):"
Write-Host "     $loginUrl"
Write-Host "  3. claude.ai (web, desktop chat, phone): Settings > Connectors > Add custom connector"
Write-Host "     Name: Google Health    URL: $mcpUrl"
Write-Host "  4. Start a new Claude Code session / restart Claude Desktop."
Write-Host ""
Write-Host "Details saved to $outFile"
