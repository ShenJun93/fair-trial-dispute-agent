param([string]$ConfigPath = $(if ($env:FT_W1_BINDING_CONFIG_PATH) { $env:FT_W1_BINDING_CONFIG_PATH } else { Join-Path (Get-Location) '.env.local' }))
$ErrorActionPreference = 'Stop'

function Read-ConfiguredValue([string]$Path, [string]$Name) {
  $envName = "Env:$Name"
  if (Test-Path $envName) { return [Environment]::GetEnvironmentVariable($Name) }
  foreach ($candidate in @($Path, (Join-Path (Get-Location) '.env'))) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    foreach ($line in [IO.File]::ReadAllLines($candidate)) {
      if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$')) {
        $value = $Matches[1].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
        if ($value) { return $value }
      }
    }
  }
  return $null
}
function SecureString-ToPlainText([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Fingerprint([string]$Value) {
  if (-not $Value) { return $null }
  $sha = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))
  return [Convert]::ToHexString($sha).ToLowerInvariant().Substring(0, 16)
}

Write-Host 'LOCAL-ONLY account verifier. No API call will be made.'
Write-Host 'Select the Support-enabled US sandbox account, then open Account > Developer > API keys.'
$selected = Read-Host 'Are you viewing that selected US sandbox account? (yes/no)'
if ($selected -notmatch '^(?i:yes)$') {
  [pscustomobject]@{ result='UNKNOWN'; liveW1Enabled=$false; provenance='LOCAL_INTERACTIVE_COMPARISON'; networkRequests=0 } | ConvertTo-Json -Compress
  exit 2
}
$clientSecure = Read-Host 'Enter the dashboard Client ID for hidden local comparison' -AsSecureString
$dashboardClient = SecureString-ToPlainText $clientSecure
$configuredClient = Read-ConfiguredValue $ConfigPath 'AIRWALLEX_CLIENT_ID'
$scopeAnswer = Read-Host 'Does the key scope explicitly include this selected US account? (yes/no/unknown)'
$scopeApplies = if ($scopeAnswer -match '^(?i:yes)$') { $true } elseif ($scopeAnswer -match '^(?i:no)$') { $false } else { 'UNKNOWN' }
$scopeChoice = Read-Host 'How many accounts are selected in this key scope? (1 / 2 for multiple / unknown)'
$scope = switch ($scopeChoice) { '1' { 'SINGLE_ACCOUNT' } '2' { 'MULTIPLE_ACCOUNTS' } default { 'UNKNOWN' } }
$documented = switch ($scope) {
  'SINGLE_ACCOUNT' { 'NOT_REQUIRED_BY_DOCUMENTATION' }
  'MULTIPLE_ACCOUNTS' { 'REQUIRED_BY_DOCUMENTATION' }
  default { 'UNKNOWN' }
}
if ($documented -eq 'NOT_REQUIRED_BY_DOCUMENTATION') {
  Write-Host 'Scope rule: x-login-as is NOT REQUIRED_BY_DOCUMENTATION for a key linked to exactly one account.'
  $exceptionAnswer = Read-Host 'Has the owner/Support explicitly reported x-login-as REQUIRED despite that rule? (yes/no/unknown)'
} elseif ($documented -eq 'REQUIRED_BY_DOCUMENTATION') {
  Write-Host 'Scope rule: x-login-as is REQUIRED_BY_DOCUMENTATION to select account-level permissions for a multi-account key.'
  $exceptionAnswer = Read-Host 'Has the owner/Support explicitly reported x-login-as NOT REQUIRED despite that rule? (yes/no/unknown)'
} else { $exceptionAnswer = 'unknown' }
$exception = if ($exceptionAnswer -match '^(?i:yes)$') { 'OPERATOR_REPORTED_CONFLICT' } elseif ($exceptionAnswer -match '^(?i:no)$') { 'NONE' } else { 'UNKNOWN' }

$targetMatch = 'NOT_APPLICABLE'
$configuredTarget = Read-ConfiguredValue $ConfigPath 'AIRWALLEX_LOGIN_AS'
$dashboardTarget = $null
if ($scope -eq 'MULTIPLE_ACCOUNTS') {
  Write-Host 'For a multi-account key, inspect the selected account ID in Account details. Input is hidden; no account ID will be printed.'
  $targetSecure = Read-Host 'Enter the selected account ID for local comparison' -AsSecureString
  $dashboardTarget = SecureString-ToPlainText $targetSecure
  $targetSelected = Read-Host 'Does that account ID identify the currently selected Support-enabled US account? (yes/no/unknown)'
  if ($configuredTarget -and $dashboardTarget -and $configuredTarget -ceq $dashboardTarget -and $targetSelected -match '^(?i:yes)$') { $targetMatch = 'MATCH' }
  elseif ($targetSelected -match '^(?i:no)$' -or ($configuredTarget -and $dashboardTarget -and $configuredTarget -cne $dashboardTarget)) { $targetMatch = 'MISMATCH' }
  else { $targetMatch = 'UNKNOWN' }
} elseif ($scope -eq 'SINGLE_ACCOUNT' -and $configuredTarget) {
  $targetMatch = 'CONFLICTING_CONFIGURATION'
}

$result = 'UNKNOWN'
if ($configuredClient -and $dashboardClient -and $configuredClient -cne $dashboardClient) { $result = 'MISMATCH' }
elseif ($scopeApplies -ceq $false) { $result = 'MISMATCH' }
elseif ($configuredClient -and $dashboardClient -and $scopeApplies -ceq $true -and $scope -ne 'UNKNOWN') { $result = 'MATCH' }
if ($scope -eq 'MULTIPLE_ACCOUNTS' -and $targetMatch -eq 'MISMATCH') { $result = 'MISMATCH' }
if ($scope -eq 'SINGLE_ACCOUNT' -and $targetMatch -eq 'CONFLICTING_CONFIGURATION') { $result = 'MISMATCH' }
$conflicts = @()
if ($exception -eq 'OPERATOR_REPORTED_CONFLICT') { $conflicts += 'OPERATOR_REPORT_CONFLICTS_WITH_DOCUMENTATION' }
if ($exception -eq 'UNKNOWN') { $conflicts += 'OPERATOR_EXCEPTION_UNRESOLVED' }
if ($targetMatch -in @('UNKNOWN','MISMATCH','CONFLICTING_CONFIGURATION')) { $conflicts += 'TARGET_ACCOUNT_BINDING_UNRESOLVED' }
$liveW1Enabled = $false # This verifier never grants operation authorization.
$receipt = [ordered]@{
  challenge = [Environment]::GetEnvironmentVariable('FT_W1_BINDING_CHALLENGE')
  result = $result
  provenance = 'LOCAL_INTERACTIVE_COMPARISON'
  origin = 'https://api.sandbox.airwallex.com'
  selectedUsSandboxAccountConfirmed = $true
  keyAppliesToSelectedUsAccount = if ($scopeApplies -is [bool]) { $scopeApplies } else { 'UNKNOWN' }
  keyAccountScope = $scope
  documentedXLoginAs = $documented
  operatorException = $exception
  targetAccountBinding = $targetMatch
  clientIdFingerprint = if ($result -eq 'MATCH') { Fingerprint $configuredClient } else { $null }
  targetAccountFingerprint = if ($targetMatch -eq 'MATCH') { Fingerprint $configuredTarget } else { $null }
  conflicts = $conflicts
  liveW1Enabled = $liveW1Enabled
  networkRequests = 0
  rawIdentifiersEmitted = $false
}
[pscustomobject]$receipt | ConvertTo-Json -Compress
$dashboardClient=$null; $configuredClient=$null; $dashboardTarget=$null; $configuredTarget=$null
$clientSecure.Dispose()
if ($scope -eq 'MULTIPLE_ACCOUNTS') { $targetSecure.Dispose() }
if ($result -ne 'MATCH' -or $conflicts.Count -gt 0) { exit 2 }
