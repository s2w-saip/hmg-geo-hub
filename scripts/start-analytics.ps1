$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& python -X utf8 (Join-Path $repoPath 'back/analytics/manage.py') init
if ($LASTEXITCODE -ne 0) { throw 'Analytics database initialization failed.' }
& python -X utf8 (Join-Path $repoPath 'back/analytics/manage.py') verify
if ($LASTEXITCODE -ne 0) { throw 'Analytics database verification failed.' }
