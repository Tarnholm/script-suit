@echo off
setlocal

set "PROJECT_DIR=%~dp0.."
set "DIST_DIR=%PROJECT_DIR%\dist\SettlementProcessorSuite"

echo === Packaging Settlement Processor Suite ===

:: Build the Electron app
echo Building Electron app...
cd /d "%~dp0"
call npx electron-builder --win --x64 --dir
if errorlevel 1 (
    echo ERROR: Electron build failed
    pause
    exit /b 1
)

:: Create distribution folder
echo Creating distribution package...
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
mkdir "%DIST_DIR%"

:: Copy Electron app
echo Copying Electron app...
xcopy "%PROJECT_DIR%\dist\win-unpacked\*" "%DIST_DIR%\app\" /s /e /q /y >nul

:: Copy Python scripts
echo Copying Python scripts...
for %%f in ("%PROJECT_DIR%\*.py") do copy "%%f" "%DIST_DIR%\" >nul
for %%f in ("%PROJECT_DIR%\*.bat") do copy "%%f" "%DIST_DIR%\" >nul

:: Copy config folder
echo Copying config...
if exist "%PROJECT_DIR%\config" (
    xcopy "%PROJECT_DIR%\config\*" "%DIST_DIR%\config\" /s /e /q /y >nul
)

:: Create launcher
echo Creating launcher...
(
echo @echo off
echo cd /d "%%~dp0"
echo start "" "app\Settlement Processor Suite.exe"
) > "%DIST_DIR%\Settlement Processor Suite.bat"

:: Create README
(
echo Settlement Processor Suite
echo ==========================
echo.
echo Requirements:
echo   - Python 3.x installed and on PATH
echo.
echo To run:
echo   - Double-click "Settlement Processor Suite.bat"
echo   - Or run app\Settlement Processor Suite.exe directly
echo.
echo The Python scripts (.py files^) must stay in this folder.
echo The config\ folder contains your game data files.
) > "%DIST_DIR%\README.txt"

echo.
echo === Done! ===
echo Distribution folder: %DIST_DIR%
echo.
echo To share: zip the "SettlementProcessorSuite" folder and send it.
echo Your friend needs Python 3.x installed.
echo.
pause
