$ErrorActionPreference = "SilentlyContinue"
$json = Get-Content "tmp_all.json" -Raw | ConvertFrom-Json
$rows = $json[0].results
"проверяю $($rows.Count) серверов..."

$jobs = [System.Collections.ArrayList]::new()

function Test-One($row) {
    $link = $row.link
    $sni = $row.host
    if ($link -match 'sni=([^&]+)') { $sni = $Matches[1] }
    $path = "/"
    if ($link -match '(?:\?|&)path=([^&]+)') { $path = [System.Uri]::UnescapeDataString($Matches[1]) }

    $code = & curl.exe -s -o NUL -w "%{http_code}" --connect-timeout 4 --max-time 7 `
        --resolve "${sni}:$($row.port):$($row.host)" ("https://{0}:{1}{2}" -f $sni, $row.port, $path)

    [pscustomobject]@{ id = $row.id; code = $code }
}

$results = [System.Collections.Concurrent.ConcurrentBag[object]]::new()

$chunks = [math]::Ceiling($rows.Count / 40)
for ($i = 0; $i -lt $chunks; $i++) {
    $slice = $rows[($i * 40)..([math]::Min(($i + 1) * 40 - 1, $rows.Count - 1))]
    $results.Add($slice)
}

$all = @()
$i = 0
foreach ($batch in $results) {
    $all += $batch
    $i++
}

# простой параллелизм через runspaces недоступен — идём пачками по 40
$working = @()
$dead = @()
$counter = 0
foreach ($batch in $results) {
    $batch | ForEach-Object -Parallel {
        $row = $_
        $link = $row.link
        $sni = $row.host
        if ($link -match 'sni=([^&]+)') { $sni = $Matches[1] }
        $path = "/"
        if ($link -match '(?:\?|&)path=([^&]+)') { $path = [System.Uri]::UnescapeDataString($Matches[1]) }
        $code = & curl.exe -s -o NUL -w "%{http_code}" --connect-timeout 4 --max-time 7 --resolve "${sni}:$($row.port):$($row.host)" ("https://{0}:{1}{2}" -f $sni, $row.port, $path)
        [pscustomobject]@{ id = $row.id; code = $code }
    } -ThrottleLimit 40 | ForEach-Object {
        if ($_.code -in @("400", "404", "426", "200", "101")) { $working += $_.id } else { $dead += $_.id }
    }
    $counter++
    if ($counter % 5 -eq 0) { "обработано $($counter * 40)..." }
}

$working -join "," | Set-Content -Encoding ascii alive_ids.txt
$dead -join "," | Set-Content -Encoding ascii dead_ids.txt
""
"рабочих: $($working.Count), мёртвых: $($dead.Count)"
