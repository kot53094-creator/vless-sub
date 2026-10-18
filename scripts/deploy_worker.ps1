# Разворачивает учёт устройств на Cloudflare Workers (бесплатный тариф).
# Нужен только бесплатный аккаунт Cloudflare — логин откроется в браузере.
#
# После запуска скрипт напечатает адрес вида https://apelsinka-vpn.<логин>.workers.dev
# Его нужно вписать в configs/worker.txt — тогда dashboard.html начнёт показывать устройства.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "worker")

Write-Host "== 1/4 Вход в Cloudflare (откроется браузер) ==" -ForegroundColor Cyan
npx --yes wrangler@latest login
if ($LASTEXITCODE -ne 0) { Write-Host "Вход не выполнен." -ForegroundColor Yellow; exit 1 }

Write-Host "== 2/4 Хранилище для статистики ==" -ForegroundColor Cyan
$cfg = Get-Content wrangler.toml -Raw
if ($cfg -match "PASTE_KV_ID") {
    $json = npx --yes wrangler@latest kv namespace create STATS --json
    $id = ($json | ConvertFrom-Json).id
    if (-not $id) { Write-Host "Не удалось создать KV-пространство." -ForegroundColor Yellow; exit 1 }
    $cfg = $cfg -replace "PASTE_KV_ID", $id
    Set-Content -Path wrangler.toml -Value $cfg -Encoding utf8
    Write-Host "KV создано: $id" -ForegroundColor Green
} else {
    Write-Host "KV уже настроено." -ForegroundColor DarkGray
}

Write-Host "== 3/4 Публикация ==" -ForegroundColor Cyan
$deploy = npx --yes wrangler@latest deploy 2>&1
$deploy | ForEach-Object { Write-Host $_ }

$url = ($deploy | Select-String -Pattern "https://[a-z0-9.\-]+\.workers\.dev" -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Last 1)

Write-Host "== 4/4 Готово ==" -ForegroundColor Cyan
if ($url) {
    Write-Host "Адрес службы: $url" -ForegroundColor Green
    Set-Content -Path (Join-Path $root "configs\worker.txt") -Value $url -Encoding utf8
    Write-Host "Записал в configs/worker.txt — пересоберите сайт (publish_ru.cmd или Run workflow)." -ForegroundColor Green
    Write-Host "Подписка для устройств: $url/s/phone  (имя после /s/ — метка устройства)" -ForegroundColor Green
} else {
    Write-Host "Адрес не найден в выводе. Скопируйте его из панели Cloudflare в configs/worker.txt." -ForegroundColor Yellow
}
