# 一条命令跑完「门槛查不到」的两类验证。
# 用法：pwsh scripts/verify/run-all.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = (Get-Location).Path }
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root '.tmp-check') | Out-Null

Write-Host ''
Write-Host '=== 1/2 renderer: real window + product CSS + D-14 probe ==='
npx electron scripts/verify/renderer-geometry.cjs
$r1 = $LASTEXITCODE
Write-Host "renderer_exit=$r1"

Write-Host ''
Write-Host '=== 2/2 main process: autosave directory level (D-19 / D-18②) ==='
npx esbuild scripts/verify/autosave-check.ts --bundle --outfile=.tmp-check/verify-autosave.cjs --platform=node --format=cjs --external:electron "--alias:@shared=./src/shared" --log-level=warning
$build = $LASTEXITCODE
if ($build -ne 0) {
  Write-Host "esbuild_exit=$build (打包失败，跳过主进程验证)"
  $r2 = $build
} else {
  npx electron .tmp-check/verify-autosave.cjs
  $r2 = $LASTEXITCODE
  Write-Host "main_exit=$r2"
}

Write-Host ''
Write-Host "SUMMARY renderer=$r1 main=$r2"
if ($r1 -eq 0 -and $r2 -eq 0) { Write-Host 'ALL GREEN' } else { Write-Host 'HAS FAILURES' }
exit ($r1 + $r2)
