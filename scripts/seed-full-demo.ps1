$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
$servicesStopped = $false
$seedExitCode = 1
try {
    docker compose stop kong app python-api temporal-worker
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stop the app/API/worker services safely (docker compose exit $LASTEXITCODE)."
    }
    $servicesStopped = $true

    New-Item -ItemType Directory -Force -Path ".local-test-accounts" | Out-Null
    docker compose --profile demo run --build --rm --no-deps demo-seed
    $seedExitCode = $LASTEXITCODE
}
finally {
    if ($servicesStopped) {
        docker compose up --build -d --wait python-api temporal-worker app kong
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            throw "The seed run ended, but the application services did not all restart successfully."
        }
        $pendingVisitors = (docker compose exec -T postgres-primary psql -h 127.0.0.1 -p 1020 -U inout -d inout -Atc "SELECT count(*) FROM permission_requests WHERE data->>'type'='visitor' AND data->>'status'='pending';").Trim()
        if ($LASTEXITCODE -ne 0 -or $pendingVisitors -ne "75") {
            Pop-Location
            throw "The services restarted, but the 75 visitor approvals did not remain pending. Inspect the Temporal worker before testing approvals."
        }
        Write-Host "Verified 75 visitor approvals remain pending after the Temporal worker started."
    }
    Pop-Location
}

if ($seedExitCode -ne 0) {
    exit $seedExitCode
}
