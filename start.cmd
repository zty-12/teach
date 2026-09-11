@echo off
chcp 65001 >nul
REM ============================================================
REM  教务工作台 - 一键启动脚本
REM  ------------------------------------------------------------
REM  双击运行本文件即可：自动安装依赖 -> 构建 -> 启动预览服务
REM  然后自动打开浏览器访问 http://localhost:4173
REM
REM  停止服务：关闭本窗口即可（服务随之停止）
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo  ==========================================
echo   教务工作台 - 正在启动...
echo  ==========================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
    echo  [错误] 未检测到 Node.js，请先安装：https://nodejs.org
    echo  安装 Node.js v22 或更高版本后重新运行本文件。
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_V=%%v
echo  [1/4] 检测到 Node.js %NODE_V%

REM ---------- 2. 检查依赖 ----------
echo  [2/4] 检查项目依赖...
if not exist "node_modules\vite\bin\vite.js" (
    echo        首次运行，正在安装依赖，请耐心等待...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo  [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo        依赖已就绪。
)

REM ---------- 3. 构建 ----------
echo  [3/4] 正在构建（首次约 5 秒）...
call npm run build
if errorlevel 1 (
    echo  [错误] 构建失败，请查看上方报错信息。
    pause
    exit /b 1
)

REM ---------- 4. 启动预览 ----------
echo  [4/4] 启动本地服务并打开浏览器...
start "" http://localhost:4173
call npx vite preview --host --port 4173

echo.
echo  服务已停止。感谢使用！
pause
