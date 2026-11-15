@echo off
setlocal
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

REM 2. 動作する pnpm の探索 (Node.js 25+ の Corepack 廃止による古いシム残存にも対応)
set "PNPM_BIN="
set "PNPM_BROKEN=0"

for %%F in (pnpm.exe pnpm.cmd pnpm.bat) do (
    if not defined PNPM_BIN (
        for /f "delims=" %%P in ('where %%F 2^>nul') do (
            call :try_pnpm "%%~P"
        )
    )
)

if defined PNPM_HOME if not defined PNPM_BIN (
    for %%P in ("%PNPM_HOME%\pnpm.exe" "%PNPM_HOME%\bin\pnpm.exe" "%PNPM_HOME%\pnpm.cmd") do (
        call :try_pnpm "%%~P"
    )
)

if defined LOCALAPPDATA if not defined PNPM_BIN (
    for %%P in ("%LOCALAPPDATA%\pnpm\pnpm.exe" "%LOCALAPPDATA%\pnpm\bin\pnpm.exe") do (
        call :try_pnpm "%%~P"
    )
)

if defined APPDATA if not defined PNPM_BIN (
    call :try_pnpm "%APPDATA%\npm\pnpm.cmd"
)

if not defined PNPM_BIN (
    if "%PNPM_BROKEN%"=="1" (
        echo [エラー] pnpm の起動に失敗しました ^(古い Node.js の Corepack シムが残っている可能性があります^)。
        echo Node.js 25 以降では Corepack が同梱されないため、スタンドアロン版 pnpm を導入し、
        echo 古いシム ^(例: C:\Program Files\nodejs\pnpm*^) を削除または PATH の順序を見直してください。
    ) else (
        echo [エラー] pnpm が見つかりません。
    )
    echo 本プロジェクトでは pnpm が必須です [npm / yarn / bun は使用禁止]。
    echo PowerShell で以下を実行してスタンドアロン版 pnpm をインストールしてください:
    echo   irm https://get.pnpm.io/install.ps1 ^| iex
    echo   ^(または winget install pnpm.pnpm^)
    echo.
    pause
    exit /b 1
)

REM 見つけた正常な pnpm のフォルダーを PATH 先頭に置いて古いシムより優先させる
for %%D in ("%PNPM_BIN%") do set "PATH=%%~dpD;%PATH%"

REM 3. node_modules の存在確認 (初回実行時の自動セットアップ)
if not exist "%~dp0node_modules" (
    echo 依存パッケージが見つかりません。pnpm install を実行します...
    call "%PNPM_BIN%" install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [エラー] pnpm install に失敗しました。
        pause
        exit /b %ERRORLEVEL%
    )
    echo.
)

REM 4. パッケージ化処理の実行
call "%PNPM_BIN%" package
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
goto :eof

:try_pnpm
if defined PNPM_BIN goto :eof
if not exist "%~1" goto :eof
call "%~1" --version >nul 2>nul
if errorlevel 1 (
    set "PNPM_BROKEN=1"
    goto :eof
)
set "PNPM_BIN=%~1"
goto :eof
