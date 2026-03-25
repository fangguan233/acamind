param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "Acamind-submit-$timestamp.zip"
$archivePath = Join-Path $RepoRoot $archiveName
$stageRoot = Join-Path $env:TEMP "acamind-submit-stage-$timestamp"
$stageRepo = Join-Path $stageRoot "chainlit-main"

if (Test-Path $stageRoot) {
    Remove-Item $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRepo | Out-Null

$excludeDirs = @(
    "node_modules",
    "frontend\node_modules",
    "frontend\dist",
    "libs\copilot\node_modules",
    "libs\copilot\dist",
    "libs\react-client\node_modules",
    "libs\react-client\dist",
    ".tmp",
    "backend\.venv",
    "backend\.cache",
    "backend\__pycache__",
    "backend\.data",
    "backend\debug_artifacts",
    "backend\public\deepread-pdf-cache",
    "new-api-docs-v1-main"
) | ForEach-Object {
    Join-Path $RepoRoot $_
} | Where-Object { Test-Path $_ }

$excludeFiles = @(
    "Acamind-slim-*.zip",
    "Acamind-submit-*.zip",
    "new-api-docs-v1-main.zip",
    ".env",
    "backend\.env",
    "frontend\tsconfig.tsbuildinfo"
)

$robocopyArgs = @(
    $RepoRoot,
    $stageRepo,
    "/E",
    "/R:1",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP"
)

foreach ($dir in $excludeDirs) {
    $robocopyArgs += "/XD"
    $robocopyArgs += $dir
}

$robocopyArgs += "/XF"
$robocopyArgs += $excludeFiles

$null = & robocopy @robocopyArgs
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

function Replace-InFile {
    param(
        [string]$Path,
        [hashtable[]]$Rules
    )

    if (-not (Test-Path $Path)) {
        return
    }

    $content = Get-Content -Path $Path -Raw -Encoding UTF8
    foreach ($rule in $Rules) {
        $content = [regex]::Replace($content, $rule.Pattern, $rule.Replacement)
    }
    Set-Content -Path $Path -Value $content -Encoding UTF8
}

$chainlitConfig = Join-Path $stageRepo "backend\.chainlit\config.toml"
Replace-InFile -Path $chainlitConfig -Rules @(
    @{ Pattern = '(?m)^app_key\s*=\s*".*"$'; Replacement = 'app_key = ""' },
    @{ Pattern = '(?m)^app_secret\s*=\s*".*"$'; Replacement = 'app_secret = ""' },
    @{ Pattern = '(?m)^app_code\s*=\s*".*"$'; Replacement = 'app_code = ""' },
    @{ Pattern = '(?m)^api_key\s*=\s*".*"$'; Replacement = 'api_key = ""' },
    @{ Pattern = '(?m)^oauth_access_token\s*=\s*".*"$'; Replacement = 'oauth_access_token = ""' },
    @{ Pattern = '(?m)^tdm_client_token\s*=\s*".*"$'; Replacement = 'tdm_client_token = ""' }
)

$mainBackend = Join-Path $stageRepo "backend\demo_openai_compatible_httpx.py"
Replace-InFile -Path $mainBackend -Rules @(
    @{ Pattern = '(?m)^OPENALEX_HARDCODED_API_KEY\s*=\s*".*"$'; Replacement = 'OPENALEX_HARDCODED_API_KEY = ""' }
)

foreach ($settingsFile in @(
    (Join-Path $stageRepo "settings.yml"),
    (Join-Path $stageRepo "searxng\settings.yml")
)) {
    Replace-InFile -Path $settingsFile -Rules @(
        @{ Pattern = '(?m)^\s*secret_key:\s*".*"'; Replacement = '  secret_key: ""' }
    )
}

$verificationTargets = @(
    $chainlitConfig,
    $mainBackend,
    (Join-Path $stageRepo "settings.yml"),
    (Join-Path $stageRepo "searxng\settings.yml")
) | Where-Object { Test-Path $_ }

$verificationPatterns = @(
    'api_key\s*=\s*"[^"]+"',
    'app_key\s*=\s*"[^"]+"',
    'app_secret\s*=\s*"[^"]+"',
    'app_code\s*=\s*"[^"]+"',
    'oauth_access_token\s*=\s*"[^"]+"',
    'tdm_client_token\s*=\s*"[^"]+"',
    'OPENALEX_HARDCODED_API_KEY\s*=\s*"[^"]+"',
    'secret_key:\s*"[^"]+"',
    'sk-[A-Za-z0-9_-]{20,}',
    'AIza[0-9A-Za-z_-]{20,}'
)

$violations = @()
foreach ($target in $verificationTargets) {
    $hits = Select-String -Path $target -Pattern $verificationPatterns
    if ($hits) {
        $violations += $hits
    }
}

if ($violations.Count -gt 0) {
    $violations | Select-Object Path, LineNumber, Line | Format-Table -AutoSize
    throw "sanitized package still contains sensitive values"
}

Push-Location $stageRoot
try {
    if (Test-Path $archivePath) {
        Remove-Item $archivePath -Force
    }
    & tar.exe -a -cf $archivePath "chainlit-main"
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$archive = Get-Item $archivePath
[PSCustomObject]@{
    Archive = $archive.FullName
    SizeMB = [math]::Round($archive.Length / 1MB, 2)
    Stage = $stageRoot
}
