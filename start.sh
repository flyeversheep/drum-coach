#!/bin/bash
# Linux / macOS 终端：bash start.sh。会在本机 8080 端口打开「鼓点跟练」。关掉这个窗口即停止。
cd "$(dirname "$0")"
(sleep 1; (xdg-open "http://localhost:8080" || open "http://localhost:8080") >/dev/null 2>&1) &
python3 -m http.server 8080
