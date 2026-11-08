@echo off
setlocal

cd /d "%~dp0"

if not exist "backend\app\main.py" (
  echo DataDesk backend was not found. Run this file from the project folder.
  pause
  exit /b 1
)
if not exist "package.json" (
  echo Frontend package.json was not found.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Frontend dependencies are missing. Run npm ci in the project folder first.
  pause
  exit /b 1
)
set "PYTHON_EXE="
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import uvicorn, fastapi, psycopg, dotenv" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
)
if not defined PYTHON_EXE (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python or create the project's .venv.
    pause
    exit /b 1
  )
  python -c "import uvicorn, fastapi, psycopg, dotenv" >nul 2>nul
  if errorlevel 1 (
    echo Backend dependencies are missing. Run python -m pip install -r requirements.txt.
    pause
    exit /b 1
  )
  set "PYTHON_EXE=python"
)
if not exist ".env" echo Warning: .env is missing. PostgreSQL mode will not be available until DATABASE_URL is configured.

start "DataDesk Backend" /D "%~dp0" "%PYTHON_EXE%" -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
start "DataDesk Frontend" /D "%~dp0" "%ComSpec%" /k "npm.cmd run dev -- --host 127.0.0.1"
timeout /t 5 /nobreak >nul
start "" "http://localhost:5173"
exit /b 0
