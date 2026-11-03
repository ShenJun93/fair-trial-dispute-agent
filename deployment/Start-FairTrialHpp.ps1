# Start the Fair Trial HPP sandbox server locally. Does not create a PaymentIntent.
# Operator supplies a private >=32-character token and uses the same value for browser login.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
if (-not (Test-Path -LiteralPath (Join-Path $repo '.env.local') -PathType Leaf)) {
    throw 'SANDBOX_ENV_CONFIG_MISSING'
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'NODE_NOT_FOUND'
}
if (Get-NetTCPConnection -State Listen -LocalPort 4242 -ErrorAction SilentlyContinue) {
    throw 'HPP_PORT_4242_ALREADY_IN_USE'
}
$secret = Read-Host -Prompt 'Enter your private HPP operator token (32+ characters; same token for browser login)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ($token.Length -lt 32) { throw 'HPP_OPERATOR_TOKEN_TOO_SHORT' }
    $env:HPP_OPERATOR_TOKEN = $token
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable token -ErrorAction SilentlyContinue
    Remove-Variable secret -ErrorAction SilentlyContinue
}
$env:HPP_PUBLIC_ORIGIN = 'https://localhost:8443'
Write-Host 'Starting HPP in W1-only mode. No PaymentIntent creation from this server.'
try {
    & node.exe --import tsx .\spike\hpp-server.ts
} finally {
    Remove-Item Env:\HPP_OPERATOR_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\HPP_PUBLIC_ORIGIN -ErrorAction SilentlyContinue
}
