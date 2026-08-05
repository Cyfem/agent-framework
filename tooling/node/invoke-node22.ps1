[CmdletBinding()]
param(
  [ValidateSet('node', 'pnpm', 'corepack')]
  [string]$Command = 'pnpm',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installDirectory = & (Join-Path $PSScriptRoot 'bootstrap-node22.ps1') -PassThru
$executable = Join-Path $installDirectory ($Command + '.cmd')
if ($Command -eq 'node') {
  $executable = Join-Path $installDirectory 'node.exe'
}
if (-not (Test-Path -LiteralPath $executable)) {
  throw "Portable command not found: $executable"
}

& $executable @CommandArguments
exit $LASTEXITCODE
