param(
    [string]$ProjectId = 'project-aff304a1-a183-4f95-bda',
    [string]$Region = 'us-central1',
    [string]$Service = 'webnest-java-playground',
    [string]$WebnestServiceAccount = '',
    [switch]$ConfirmedPaidAccountWithBudget
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmedPaidAccountWithBudget) {
    throw 'Deployment uses a paid billing account. Free-tier allowances and budget alerts do not guarantee a zero bill. Confirm a budget alert exists under Billing > Budgets & alerts, then pass -ConfirmedPaidAccountWithBudget.'
}
if (Test-Path -LiteralPath 'D:\Tools\google-cloud-sdk\bin\gcloud.cmd') {
    $gcloud = 'D:\Tools\google-cloud-sdk\bin\gcloud.cmd'
    $env:CLOUDSDK_CONFIG = 'D:\Tools\gcloud-config'
    $env:CLOUDSDK_PYTHON = 'D:\Python\python.exe'
    $env:TEMP = 'D:\Tools\tmp'
    $env:TMP = 'D:\Tools\tmp'
} else { $gcloud = (Get-Command gcloud -ErrorAction Stop).Source }

function Invoke-Gcloud {
    # gcloud writes progress to stderr; Windows PowerShell would turn that into a terminating error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    & $gcloud @args
    if ($LASTEXITCODE -ne 0) { throw "gcloud failed with exit code $LASTEXITCODE" }
}

$account = & $gcloud auth list --filter=status:ACTIVE --format='value(account)'
if ($LASTEXITCODE -ne 0 -or -not $account) { throw 'Sign in first using gcloud auth login. See README.md.' }
$billing = Invoke-Gcloud billing projects describe $ProjectId --format='value(billingEnabled)'
if ($billing -ne 'True' -and $billing -ne 'true') { throw 'The project needs an enabled billing account, including for Free Tier use.' }

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com --project=$ProjectId
    $repository = 'webnest-playground'
    $repositories = Invoke-Gcloud artifacts repositories list --project=$ProjectId --location=$Region --format='value(name)'
    if (-not ($repositories | Where-Object { $_ -match "(^|/)$repository$" })) {
        Invoke-Gcloud artifacts repositories create $repository --project=$ProjectId --location=$Region --repository-format=docker --description='Webnest Java playground images'
    }
    # Each image is roughly 0.5 GB and storage beyond the free allowance is billed; keep only the newest two.
    $cleanupPolicy = Join-Path ([IO.Path]::GetTempPath()) 'webnest-cleanup-policy.json'
    Set-Content -LiteralPath $cleanupPolicy -Encoding ascii -Value '[{"name":"keep-newest-2","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":2}},{"name":"delete-older","action":{"type":"Delete"},"condition":{"tagState":"any"}}]'
    try {
        Invoke-Gcloud artifacts repositories set-cleanup-policies $repository --project=$ProjectId --location=$Region --policy=$cleanupPolicy --no-dry-run
    } finally { Remove-Item -LiteralPath $cleanupPolicy -ErrorAction SilentlyContinue }
    $runtimeAccount = "java-playground-runtime@$ProjectId.iam.gserviceaccount.com"
    $accounts = Invoke-Gcloud iam service-accounts list --project=$ProjectId --format='value(email)'
    if ($accounts -notcontains $runtimeAccount) {
        Invoke-Gcloud iam service-accounts create java-playground-runtime --project=$ProjectId --display-name='Java playground runtime (no project roles)'
    }
    # New projects run Cloud Build as the Compute Engine default account with no roles; grant only what a build needs.
    $projectNumber = Invoke-Gcloud projects describe $ProjectId --format='value(projectNumber)'
    $buildMember = "serviceAccount:$projectNumber-compute@developer.gserviceaccount.com"
    $sourceBucket = "gs://${ProjectId}_cloudbuild"
    $ErrorActionPreference = 'Continue'
    & $gcloud storage buckets describe $sourceBucket --project=$ProjectId --format='value(name)' 2>$null | Out-Null
    $bucketExists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $bucketExists) { Invoke-Gcloud storage buckets create $sourceBucket --project=$ProjectId --location=US --uniform-bucket-level-access }
    Invoke-Gcloud storage buckets add-iam-policy-binding $sourceBucket --member=$buildMember --role=roles/storage.objectViewer --format=none
    Invoke-Gcloud artifacts repositories add-iam-policy-binding $repository --project=$ProjectId --location=$Region --member=$buildMember --role=roles/artifactregistry.writer --format=none
    Invoke-Gcloud projects add-iam-policy-binding $ProjectId --member=$buildMember --role=roles/logging.logWriter --condition=None --format=none
    $tag = Get-Date -Format 'yyyyMMdd-HHmmss'
    $image = "${Region}-docker.pkg.dev/$ProjectId/$repository/java-playground:$tag"
    Invoke-Gcloud builds submit . --project=$ProjectId --region=$Region --tag=$image --timeout=1200
    Invoke-Gcloud beta run deploy $Service --project=$ProjectId --region=$Region --image=$image --sandbox-launcher --execution-environment=gen2 --service-account=$runtimeAccount --no-allow-unauthenticated --concurrency=1 --cpu=1 --memory=1Gi --min-instances=0 --max-instances=1 --timeout=60 --port=8080 --set-env-vars=EXECUTION_MODE=cloud-run --cpu-throttling
    if ($WebnestServiceAccount) {
        Invoke-Gcloud run services add-iam-policy-binding $Service --project=$ProjectId --region=$Region --member="serviceAccount:$WebnestServiceAccount" --role=roles/run.invoker
    }
    $url = Invoke-Gcloud run services describe $Service --project=$ProjectId --region=$Region --format='value(status.url)'
    Write-Host "Deployed private playground: $url"
    Write-Host 'Next: run the authenticated cloud smoke tests described in README.md.'
} finally { Pop-Location }
