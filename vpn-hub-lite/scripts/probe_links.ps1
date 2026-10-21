$ErrorActionPreference = "SilentlyContinue"
$json = Get-Content "tmp_links.json" -Raw | ConvertFrom-Json
$rows = $json[0].results

$ok = 0
$bad = 0
$results = @()

foreach ($row in $rows) {
    $sni = ""
    if ($row.link -match 'sni=([^&]+)') { $sni = $Matches[1] }

    $tcp = New-Object System.Net.Sockets.TcpClient
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $connected = $false
    try {
        $task = $tcp.ConnectAsync($row.host, $row.port)
        $connected = $task.Wait(4000)
    } catch { $connected = $false }
    $ms = $sw.ElapsedMilliseconds
    $tcp.Close()

    if ($connected) {
        $ok++
        $results += "OK   {0}:{1}  {2} ms  sni={3}" -f $row.host, $row.port, $ms, $sni
    } else {
        $bad++
        $results += "DEAD {0}:{1}  timeout/sni={2}" -f $row.host, $row.port, $sni
    }
}

$results | ForEach-Object { $_ }
""
"TCP РѕС‚РєСЂС‹С‚: $ok, РЅРµРґРѕСЃС‚СѓРїРЅРѕ: $bad, РІСЃРµРіРѕ: $($rows.Count)"

