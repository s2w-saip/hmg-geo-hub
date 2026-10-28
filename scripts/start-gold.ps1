$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frontPath = Join-Path $repoPath 'front'
$secretPath = Join-Path $repoPath '.env.gold.local'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'Create the git-ignored .env.gold.local with HGH_GOLD_DB_URL first.'
}
Push-Location -LiteralPath $repoPath
try {
    # Validate DB networks before stopping the currently running API.
    $analyticsEnv = Join-Path $repoPath '.env.analytics.local'
    $operationsEnv = Join-Path $repoPath '.env.operations.local'
    if (Test-Path -LiteralPath $analyticsEnv -PathType Leaf) {
        docker network inspect hgh-analytics-network 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Start HUB storage with scripts/start-hub-storage.ps1 first.' }
    }
    if (Test-Path -LiteralPath $operationsEnv -PathType Leaf) {
        docker network inspect hgh-operations-network 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Start HUB storage with scripts/start-hub-storage.ps1 first.' }
    }
    docker build -t hgh-gold-api:local back/bff
    if ($LASTEXITCODE -ne 0) { throw 'Gold API build failed.' }
    $existingContainer = docker ps -aq --filter 'name=^hgh-gold-api$'
    if ($existingContainer) {
        docker stop hgh-gold-api | Out-Null
        docker rm hgh-gold-api | Out-Null
    }
    $runArgs = @('run', '-d', '--name', 'hgh-gold-api', '--restart', 'unless-stopped', '--env-file', $secretPath, '-p', '127.0.0.1:5555:8000')
    if (Test-Path -LiteralPath $analyticsEnv -PathType Leaf) {
        $runArgs += @('--network', 'hgh-analytics-network', '--env-file', $analyticsEnv)
    }
    if (Test-Path -LiteralPath $operationsEnv -PathType Leaf) {
        $runArgs += @('--env-file', $operationsEnv)
    }
    # Global prompt editing (manage.py init writes it): the INSERT-only catalog role and the login token secret.
    $editEnv = Join-Path $repoPath '.env.hub-edit.local'
    if ((Test-Path -LiteralPath $editEnv -PathType Leaf) -and (Test-Path -LiteralPath $analyticsEnv -PathType Leaf)) {
        $runArgs += @('--env-file', $editEnv)
    }
    $runArgs += 'hgh-gold-api:local'
    & docker @runArgs
    if ($LASTEXITCODE -ne 0) { throw 'Gold API start failed.' }
    if (Test-Path -LiteralPath $operationsEnv -PathType Leaf) {
        docker network connect hgh-operations-network hgh-gold-api
        if ($LASTEXITCODE -ne 0) { throw 'Operations network connection failed.' }
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:5555/healthz' -TimeoutSec 2
            $operationsReady = -not (Test-Path -LiteralPath $operationsEnv) -or $health.operations.ok
            $analyticsReady = -not (Test-Path -LiteralPath $analyticsEnv) -or $health.analytics.ok
            if ($health.database -eq 'gold' -and $health.read_only -eq 'on' -and $operationsReady -and $analyticsReady) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Gold read-only health check failed.' }
    $env:HGH_LOCAL_READ_ONLY = '1'
    $env:HGH_API_BASE_URL = 'http://127.0.0.1:5555'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    $listener = Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        $logs = Join-Path $repoPath '.local'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        Start-Process -FilePath 'node' -ArgumentList @('node_modules/next/dist/bin/next', 'dev', '--turbopack', '--hostname', '127.0.0.1', '--port', '3333') -WorkingDirectory $frontPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'front.log') -RedirectStandardError (Join-Path $logs 'front-error.log') | Out-Null
    }
    Write-Host 'Gold read-only API ready. Frontend: http://127.0.0.1:3333/ko/renewal/dashboard'
} finally { Pop-Location }
