@echo off
setlocal
set "QINGSI_ACTION=%~1"
set "QINGSI_RESULT=1"
if "%QINGSI_ACTION%"=="start" goto check_wsl
if "%QINGSI_ACTION%"=="stop" goto check_wsl
if "%QINGSI_ACTION%"=="status" goto check_wsl
if "%QINGSI_ACTION%"=="restart" goto check_wsl
echo Unsupported QingSi Games command.
goto finish

:check_wsl
where wsl.exe >nul 2>&1
if errorlevel 1 goto unavailable
call :invoke_wsl /bin/true >nul 2>&1
if errorlevel 1 goto unavailable
call :invoke_wsl /bin/bash -lc "exec '/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh' %QINGSI_ACTION%"
set "QINGSI_RESULT=%errorlevel%"
goto finish

:unavailable
echo WSL is unavailable.
goto finish

:finish
echo.
if defined QINGSI_NO_PAUSE goto done
echo Press any key to close.
pause >nul
:done
endlocal & exit /b %QINGSI_RESULT%

:invoke_wsl
if defined QINGSI_WSL_DISTRO goto named_distro
wsl.exe --exec %*
exit /b %errorlevel%
:named_distro
wsl.exe --distribution "%QINGSI_WSL_DISTRO%" --exec %*
exit /b %errorlevel%
