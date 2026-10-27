$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $repoPath
try {
    python -X utf8 back/hub_storage/manage.py init
    if ($LASTEXITCODE -ne 0) { throw 'HUB storage initialization failed.' }
    & (Join-Path $PSScriptRoot 'start-gold.ps1')
    python -X utf8 back/hub_storage/manage.py sync-gold-catalog
    if ($LASTEXITCODE -ne 0) { throw 'Gold catalog import failed.' }
    python -X utf8 back/hub_storage/manage.py verify
    if ($LASTEXITCODE -ne 0) { throw 'HUB storage verification failed.' }
} finally { Pop-Location }
