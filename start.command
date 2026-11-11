#!/bin/bash
# macOS：双击运行。会在本机 8080 端口打开「鼓点跟练」。关掉这个窗口即停止。
cd "$(dirname "$0")"
(sleep 1; open "http://localhost:8080") &
python3 -m http.server 8080
