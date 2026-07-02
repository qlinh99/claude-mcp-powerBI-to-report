@echo off
setlocal EnableDelayedExpansion
title mcp-powerBI-to-report - Cai dat cho Claude Desktop

echo ============================================================
echo   mcp-powerBI-to-report - Cai dat MCP cho Claude Desktop
echo ============================================================
echo.
echo Script nay se:
echo   1. Tai (hoac cap nhat) repo ve %%USERPROFILE%%\mcp-powerBI-to-report
echo   2. Cai dependencies va binary Modeling MCP cua Microsoft
echo   3. Ghi cau hinh vao Claude Desktop (claude_desktop_config.json)
echo.
echo Yeu cau: da cai Git va Node.js (bo qua neu chua co, script se
echo thu tu cai bang winget).
echo.
echo QUAN TRONG: dong hoan toan Claude Desktop (Quit tu system tray)
echo truoc khi tiep tuc, de tranh bi ghi de cau hinh.
echo.
pause

set "WORKSPACE="
set /p WORKSPACE="Nhap ten Power BI/Fabric workspace can ket noi (vi du: GSM_MCP_POC_WORKSPACE): "
if "%WORKSPACE%"=="" (
  echo.
  echo [Loi] Ban phai nhap ten workspace. Chay lai file nay va nhap ten workspace.
  pause
  exit /b 1
)

set "INSTALLER=%TEMP%\install-powerbi-mcp.ps1"

echo.
echo Dang tai installer moi nhat tu GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/install-windows.ps1' -OutFile '%INSTALLER%'"
if errorlevel 1 (
  echo.
  echo [Loi] Khong tai duoc installer. Kiem tra ket noi mang roi thu lai.
  pause
  exit /b 1
)

echo.
echo Dang cai dat, qua trinh nay co the mat vai phut...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" -Workspace "%WORKSPACE%"
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
  echo ============================================================
  echo   Cai dat hoan tat!
  echo   Hay mo lai Claude Desktop, sau do hoi Claude:
  echo   "Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup."
  echo ============================================================
) else (
  echo ============================================================
  echo   Cai dat that bai voi ma loi %RESULT%.
  echo   Xem thong bao loi phia tren de biet nguyen nhan.
  echo ============================================================
)
echo.
pause
