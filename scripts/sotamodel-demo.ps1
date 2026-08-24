[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("doctor", "start", "approve")]
  [string]$Command,

  [string]$RunId,
  [string]$Approver,
  [string]$Reason
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configurationFile = Join-Path $projectRoot "infra\compose\questlab-sotamodel.env"

if (-not (Test-Path -LiteralPath $configurationFile -PathType Leaf)) {
  throw "SotaModel configuration is missing: $configurationFile"
}

# A newly opened process does not always inherit a Windows machine-level variable.
# Copy it only into this child process; do not print, persist, or pass it as an argument.
if (-not $env:SOTAMODEL_API_KEY) {
  $machineKey = [Environment]::GetEnvironmentVariable("SOTAMODEL_API_KEY", "Machine")
  $userKey = [Environment]::GetEnvironmentVariable("SOTAMODEL_API_KEY", "User")
  $env:SOTAMODEL_API_KEY = if ($machineKey) { $machineKey } else { $userKey }
}
if (-not $env:SOTAMODEL_API_KEY) {
  throw "SOTAMODEL_API_KEY is not configured in the process, user, or machine environment."
}

Push-Location $projectRoot
try {
  if ($Command -eq "doctor") {
    & node --env-file=$configurationFile packages/model-gateway/src/model-cli.ts doctor
    exit $LASTEXITCODE
  }

  if (-not $RunId) {
    throw "-RunId is required for $Command."
  }
  $arguments = @("--env-file=$configurationFile", "packages/control-plane/src/model-local-demo.ts", $Command, "--run-id", $RunId)
  if ($Command -eq "approve") {
    if (-not $Approver -or -not $Reason) {
      throw "-Approver and -Reason are required for approve."
    }
    $arguments += @("--approver", $Approver, "--reason", $Reason)
  }
  & node @arguments
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:SOTAMODEL_API_KEY -ErrorAction SilentlyContinue
  Pop-Location
}
