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

# 2. pnpm の確認
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[エラー] pnpm が見つかりません。" -ForegroundColor Red
    Write-Host "本プロジェクトでは pnpm が必須です (npm / yarn / bun は使用禁止)。" -ForegroundColor Yellow
    Write-Host "PowerShell / コマンドプロンプトで以下を実行してインストールしてください:" -ForegroundColor Yellow
    Write-Host "  corepack enable  または  npm i -g pnpm" -ForegroundColor Yellow
    Read-Host "Enterキーを押して終了してください..."
    exit 1
}

# 3. node_modules の確認
$nodeModules = Join-Path $rootPath "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "[1/2] 依存パッケージをセットアップしています (pnpm install)..." -ForegroundColor Yellow
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[エラー] pnpm install に失敗しました。" -ForegroundColor Red
        Read-Host "Enterキーを押して終了してください..."
        exit $LASTEXITCODE
    }
}

# 4. 最新版のビルド (dist フォルダ生成)
Write-Host "[1/2] 拡張機能の最新版を展開フォルダー (dist) に配置しています..." -ForegroundColor Yellow
& pnpm run build
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
