@echo off
rem Windows: double-click to run. Needs Python (python.org) installed.
cd /d "%~dp0"
start "" "http://localhost:8080"
python -m http.server 8080
