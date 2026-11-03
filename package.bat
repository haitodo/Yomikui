@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ======================================================================
echo    Yomikui - 拡張機能パッケージ化 (CRX / ZIP 生成)
echo ======================================================================
echo.

REM 1. Node.js の存在確認
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [エラー] Node.js が見つかりません。Node.js 20以上をインストールしてください。
    echo.
    pause
    exit /b 1
)

REM 2. pnpm の存在確認
where pnpm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [エラー] pnpm が見つかりません。
    echo 本プロジェクトでは pnpm が必須です [npm / yarn / bun は使用禁止]。
    echo corepack enable または npm i -g pnpm でインストールしてください。
    echo.
    pause
    exit /b 1
)

REM 3. node_modules の存在確認 (初回実行時の自動セットアップ)
if not exist "%~dp0node_modules" (
    echo 依存パッケージが見つかりません。pnpm install を実行します...
    call pnpm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [エラー] pnpm install に失敗しました。
        pause
        exit /b %ERRORLEVEL%
    )
    echo.
)

REM 4. パッケージ化処理の実行
call pnpm package
if %ERRORLEVEL% neq 0 (
    echo.
    echo [エラー] パッケージ化中にエラーが発生しました。
    pause
    exit /b %ERRORLEVEL%
)

REM 5. 出力先フォルダー (release) をエクスプローラーで開く
if exist "%~dp0release" (
    echo 出力先フォルダー [release] をエクスプローラーで開きます...
    start "" explorer "%~dp0release"
)
echo.
pause
