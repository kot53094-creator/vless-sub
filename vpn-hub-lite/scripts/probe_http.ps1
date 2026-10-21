$ErrorActionPreference = "SilentlyContinue"
$json = Get-Content "tmp_links.json" -Raw | ConvertFrom-Json
$rows = $json[0].results

$good = 0
$bad = 0

foreach ($row in $rows) {
    $link = $row.link
    $sni = ""
    if ($link -match 'sni=([^&]+)') { $sni = $Matches[1] }
    $path = "/"
    if ($link -match '(?:\?|&)path=([^&]+)') { $path = [System.Uri]::UnescapeDataString($Matches[1]) }
    if (-not $sni) { $sni = $row.host }

    $url = "https://{0}:{1}{2}" -f $sni, $row.port, $path
    $code = & curl.exe -s -o NUL -w "%{http_code}" --connect-timeout 5 --max-time 9 `
        --resolve "${sni}:$($row.port):$($row.host)" $url

    # 400/404/426 — endpoint жив (WS-прокси отвечает). 5xx/000 — нет.
    if ($code -in @("400", "404", "426", "200", "101")) {
        $good++
        "OK    {0,-45} -> {1}" -f $sni, $code
    } else {
        $bad++
        "BAD   {0,-45} -> {1}" -f $sni, $code
    }
}

""
"отвечают: $good, не отвечают: $bad, всего: $($rows.Count)"
