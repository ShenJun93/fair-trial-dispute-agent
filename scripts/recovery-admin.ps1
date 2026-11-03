param([Parameter(Mandatory=$true)][ValidateSet('setup','auth')][string]$Action, [Parameter(Mandatory=$true)][string]$CredentialFile)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'setup') {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Output 'ADMIN_REQUIRED'; exit 8 }
  if (Test-Path -LiteralPath $CredentialFile) { Write-Output 'EXISTS'; exit 2 }
  $secret = Read-Host 'Create recovery administrator credential' -AsSecureString
  if ($secret.Length -lt 24) { Write-Output 'TOO_SHORT'; exit 3 }
  $parent = Split-Path -Parent $CredentialFile
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $encoded = ConvertFrom-SecureString -SecureString $secret
  $created = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $tmp = "$CredentialFile.tmp"
  [IO.File]::WriteAllLines($tmp, @($created.ToString(), $encoded), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $CredentialFile
  $secret.Dispose()
  Write-Output 'CREATED'
  exit 0
}
if (-not (Test-Path -LiteralPath $CredentialFile)) { Write-Output 'MISSING'; exit 4 }
$lines = [IO.File]::ReadAllLines($CredentialFile)
$createdAt = 0
if ($lines.Length -ne 2 -or -not [int64]::TryParse($lines[0], [ref]$createdAt) -or ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $createdAt) -gt 2592000000 -or $createdAt -gt ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 300000)) { Write-Output 'STALE'; exit 5 }
try { $saved = ConvertTo-SecureString -String $lines[1] } catch { Write-Output 'INVALID'; exit 6 }
$entered = Read-Host 'Recovery administrator credential' -AsSecureString
$a = [IntPtr]::Zero; $b = [IntPtr]::Zero
try {
  $a = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($saved)
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($entered)
  $left = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($a)
  $right = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  if ([string]::Equals($left, $right, [StringComparison]::Ordinal)) { Write-Output 'AUTH_OK'; exit 0 }
  Write-Output 'AUTH_DENIED'; exit 7
} finally {
  if ($a -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($a) }
  if ($b -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  $saved.Dispose(); $entered.Dispose()
}
