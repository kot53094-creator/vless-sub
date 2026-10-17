# Builds the subscription from THIS computer's network, keeps only configs that
# actually carried traffic, publishes the result as docs/sub-ru.txt and asks
# GitHub Actions to redeploy the site.
#
# Run it from a terminal or double-click publish_ru.cmd in the repository root.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Личные подписки: файл private_urls.txt (в .gitignore, по одной ссылке на строку).
# Он остаётся только на этом компьютере; в репозиторий попадает лишь результат.
$privateFile = Join-Path $root "private_urls.txt"
if (Test-Path $privateFile) {
    $urls = (Get-Content $privateFile | Where-Object { $_.Trim() -and -not $_.StartsWith("#") }) -join " "
    if ($urls) {
        $env:PRIVATE_SUB_URL = $urls
        $env:INCLUDE_PRIVATE = "true"
        Write-Host "Личные подписки: подключены из private_urls.txt" -ForegroundColor DarkGray
    }
}

Write-Host "== 1/4 Сборка и проверка трафиком (это несколько минут) ==" -ForegroundColor Cyan
python scripts\merge.py --out build_ru --prev docs\sub-ru.txt --deep-limit 0
if ($LASTEXITCODE -ne 0) {
    Write-Host "Сборка не дала результата (код $LASTEXITCODE). Прежний список не тронут." -ForegroundColor Yellow
    exit $LASTEXITCODE
}

Write-Host "== 2/4 Копирую результат в docs/ ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path docs | Out-Null
Copy-Item build_ru\sub.txt       docs\sub-ru.txt       -Force
Copy-Item build_ru\sub-plain.txt docs\sub-ru-plain.txt -Force
Copy-Item build_ru\status.json   docs\status-ru.json   -Force

$status = Get-Content build_ru\status.json -Raw | ConvertFrom-Json
Write-Host ("Рабочих узлов: {0} (проверено {1})" -f $status.configs, $status.deep_test.checked) -ForegroundColor Green

Write-Host "== 3/4 Коммит ==" -ForegroundColor Cyan
git add docs\sub-ru.txt docs\sub-ru-plain.txt docs\status-ru.json
git -c user.name="local-build" -c user.email="local-build@users.noreply.github.com" commit -m "chore: refresh RU-verified list"
$committed = ($LASTEXITCODE -eq 0)

if ($committed) {
    Write-Host "== 4/4 Публикация ==" -ForegroundColor Cyan
    git push
    if ($LASTEXITCODE -ne 0) {
        Write-Host "git push не прошёл. Выполните один раз: gh auth setup-git" -ForegroundColor Yellow
        exit 1
    }
    # Pages публикуется только из workflow, поэтому просим его пересобрать сайт.
    gh workflow run update.yml
    Write-Host "Готово. Сайт обновится через несколько минут: подписка sub-ru.txt" -ForegroundColor Green
} else {
    Write-Host "Изменений нет — список не изменился." -ForegroundColor Green
}
