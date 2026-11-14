#!/usr/bin/env bash
# Print Nimbus launcher for macOS / Linux laptops (uses CUPS).
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 22 LTS from https://nodejs.org first."; exit 1; }
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund
export PORT="${PORT:-3000}" PRINT_BACKEND="${PRINT_BACKEND:-cups}"
echo "Print Nimbus on http://localhost:$PORT (Ctrl+C to stop)"
( sleep 2; (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/admin") || (command -v open >/dev/null && open "http://localhost:$PORT/admin") ) >/dev/null 2>&1 &
exec node --disable-warning=ExperimentalWarning src/server.js
