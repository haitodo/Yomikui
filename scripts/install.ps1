[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$rootPath = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $rootPath

try {
    $Host.UI.RawUI.WindowTitle = "Yomikui - インストール案内"
} catch {}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   Yomikui - 拡張機能インストール案内 (Edge / Chrome)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js の確認
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[エラー] Node.js が見つかりません。Node.js (v20以上) をインストールしてください。" -ForegroundColor Red
    Read-Host "Enterキーを押して終了してください..."
    exit 1
}

# 2. 動作する pnpm の探索 (Node.js 25+ の Corepack 廃止による古いシム残存にも対応)
function Find-WorkingPnpm {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    $addCandidate = {
        param([string]$Path)
        if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
            if ($seen.Add($Path)) {
                $candidates.Add($Path)
            }
        }
    }

    foreach ($cmd in (Get-Command pnpm -All -ErrorAction SilentlyContinue | Sort-Object {
        if ($_.Source -like "*.exe") { 0 } elseif ($_.Source -like "*.cmd") { 1 } elseif ($_.Source -like "*.ps1") { 2 } else { 3 }
    })) {
        & $addCandidate $cmd.Source
    }

    if ($env:PNPM_HOME) {
        & $addCandidate (Join-Path $env:PNPM_HOME "pnpm.exe")
        & $addCandidate (Join-Path $env:PNPM_HOME "bin\pnpm.exe")
        & $addCandidate (Join-Path $env:PNPM_HOME "pnpm.cmd")
    }
    if ($env:LOCALAPPDATA) {
        & $addCandidate (Join-Path $env:LOCALAPPDATA "pnpm\pnpm.exe")
        & $addCandidate (Join-Path $env:LOCALAPPDATA "pnpm\bin\pnpm.exe")
    }
    if ($env:APPDATA) {
        & $addCandidate (Join-Path $env:APPDATA "npm\pnpm.cmd")
    }

    $hadBroken = $false
    foreach ($candidate in $candidates) {
        $ext = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
        if ($ext -notin @(".exe", ".cmd", ".bat", ".ps1")) {
            continue
        }
        try {
            & $candidate --version *> $null
            if ($LASTEXITCODE -eq 0) {
                return [PSCustomObject]@{ Path = $candidate; HadBroken = $hadBroken }
            }
            $hadBroken = $true
        } catch {
            $hadBroken = $true
        }
    }

    return [PSCustomObject]@{ Path = $null; HadBroken = $hadBroken }
}

$pnpmResult = Find-WorkingPnpm
$pnpmBin = $pnpmResult.Path
if (-not $pnpmBin) {
    if ($pnpmResult.HadBroken) {
        Write-Host "[エラー] pnpm の起動に失敗しました (古い Node.js の Corepack シムが残っている可能性があります)。" -ForegroundColor Red
        Write-Host "Node.js 25 以降では Corepack が同梱されないため、スタンドアロン版 pnpm を導入し、" -ForegroundColor Yellow
        Write-Host "古いシム (例: C:\Program Files\nodejs\pnpm*) を削除または PATH の順序を見直してください。" -ForegroundColor Yellow
    } else {
        Write-Host "[エラー] pnpm が見つかりません。" -ForegroundColor Red
    }
    Write-Host "本プロジェクトでは pnpm が必須です (npm / yarn / bun は使用禁止)。" -ForegroundColor Yellow
    Write-Host "PowerShell で以下を実行してスタンドアロン版 pnpm をインストールしてください:" -ForegroundColor Yellow
    Write-Host "  irm https://get.pnpm.io/install.ps1 | iex  (または winget install pnpm.pnpm)" -ForegroundColor Yellow
    Read-Host "Enterキーを押して終了してください..."
    exit 1
}

$env:PATH = "$(Split-Path -Parent $pnpmBin);$env:PATH"

# 3. node_modules の確認
$nodeModules = Join-Path $rootPath "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "[1/2] 依存パッケージをセットアップしています (pnpm install)..." -ForegroundColor Yellow
    & $pnpmBin install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[エラー] pnpm install に失敗しました。" -ForegroundColor Red
        Read-Host "Enterキーを押して終了してください..."
        exit $LASTEXITCODE
    }
}

# 4. 最新版のビルド (dist フォルダ生成)
Write-Host "[1/2] 拡張機能の最新版を展開フォルダー (dist) に配置しています..." -ForegroundColor Yellow
& $pnpmBin run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[エラー] ビルドに失敗しました。" -ForegroundColor Red
    Read-Host "Enterキーを押して終了してください..."
    exit $LASTEXITCODE
}
Write-Host "     -> 展開フォルダー (dist) の準備が完了しました" -ForegroundColor Green
Write-Host ""

# 5. ブラウザの選択
Write-Host "普段お使いのブラウザを選択してください:" -ForegroundColor White
Write-Host "  [1] Microsoft Edge (推奨)" -ForegroundColor Green
Write-Host "  [2] Google Chrome" -ForegroundColor White
$choice = Read-Host "番号を入力してEnter (未入力は 1)"

$distPath = Join-Path $rootPath "dist"

if ($choice -eq "2") {
    $browserName = "Google Chrome"
    $extUrl = "chrome://extensions"
    $btnName = "パッケージ化されていない拡張機能を読み込む"
    $browserExe = "chrome.exe"
} else {
    $browserName = "Microsoft Edge"
    $extUrl = "edge://extensions"
    $btnName = "展開して読み込む"
    $browserExe = "msedge.exe"
}

# 6. クリップボードへのパスコピー
try {
    Set-Clipboard -Value $distPath
    $copiedNote = "（展開フォルダーのパスをクリップボードにコピーしました！ 選択ダイアログで Ctrl + V で貼り付け可能です）"
} catch {
    $copiedNote = ""
}

# 7. 展開フォルダーをエクスプローラーで開く
Write-Host "`n[2/2] 読み込むフォルダー (dist) をエクスプローラーで開いています..." -ForegroundColor Yellow
Start-Process "explorer.exe" "`"$distPath`""

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "   【$browserName での簡単インストール手順】" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  展開先フォルダー: $distPath" -ForegroundColor White
if ($copiedNote) {
    Write-Host "  $copiedNote" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  1. $browserName のアドレスバーに以下を入力して開きます:" -ForegroundColor White
Write-Host "     $extUrl" -ForegroundColor Cyan
Write-Host "  2. 画面内の「開発者モード」スイッチを ON にします" -ForegroundColor White
Write-Host "  3. 「$btnName」ボタンをクリックします" -ForegroundColor White
Write-Host "  4. 先ほど自動で開いたフォルダー (dist) を選択します" -ForegroundColor White
Write-Host "     ※自動で開いたエクスプローラーから「dist」フォルダーを" -ForegroundColor Gray
Write-Host "       ブラウザ画面へ直接ドラッグ＆ドロップするだけでも読み込めます！" -ForegroundColor Gray
Write-Host ""
Write-Host "  ★ 読み込み後、ブラウザ右上の拡張機能アイコン (パズルピース) から" -ForegroundColor White
Write-Host "     「Yomikui」をピン留めすると便利にお使いいただけます！" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# 8. ブラウザの拡張機能ページを開くか確認
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    try {
        $openBrowser = Read-Host "今すぐ $browserName の拡張機能ページ ($extUrl) を開きますか？ [Y/N] (既定: Y)"
        if ([string]::IsNullOrWhiteSpace($openBrowser) -or $openBrowser.Trim().ToUpper() -eq "Y") {
            Start-Process $browserExe $extUrl
        }
    } catch {}

    Write-Host ""
    Read-Host "完了したらEnterキーを押してこの画面を閉じてください..."
} else {
    Write-Host "完了しました。"
}
