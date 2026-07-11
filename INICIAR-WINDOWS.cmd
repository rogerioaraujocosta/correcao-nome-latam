@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0package.json" (
  echo ERRO: package.json nao foi encontrado nesta pasta.
  echo Baixe e instale o projeto antes de iniciar.
  pause
  exit /b 1
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. O instalador sera aberto agora.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
  exit /b 0
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm nao foi encontrado. O instalador sera aberto agora.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
  exit /b 0
)
call npm run doctor >nul 2>nul
if errorlevel 1 (
  echo A configuracao inicial ainda nao foi concluida. Abrindo o assistente...
  call npm run setup
) else (
  call npm start
)
if errorlevel 1 (
  echo.
  echo O bot terminou com erro. Leia a mensagem acima.
  pause
  exit /b 1
)
