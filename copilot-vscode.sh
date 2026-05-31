#!/usr/bin/env bash
# copilot-vscode — Run a DETACHED proxy that VS Code Copilot uses as its
# "Ollama" model provider (shows ALL your models; switch live in the picker).
#
# The proxy survives terminal close. Logs are isolated under proxy/.cache/vscode/.
#
# Usage:
#   copilot-vscode [-b nvidia|deepseek|kimi] [--port N]   # start detached proxy
#   copilot-vscode --setup     # point VS Code's Ollama endpoint at the proxy
#   copilot-vscode --config    # print manual VS Code steps
#   copilot-vscode --models    # list model ids to enable in VS Code
#   copilot-vscode --logs      # tail VS Code's request log on the proxy
#   copilot-vscode --status    # show the running proxy status
#   copilot-vscode --stop      # stop the detached proxy
#   copilot-vscode --help

set -euo pipefail

_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"; _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"; unset _SOURCE _DIR

SURFACE="vscode"
source "$SCRIPT_DIR/proxy/launcher-common.sh"
load_env

PORT="${DEEPCOPILOT_PORT:-11434}"
BACKEND="${API_PROVIDER:-nvidia}"
ACTION="daemon"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --port)       PORT="$2"; shift 2 ;;
        --setup)      ACTION="setup"; shift ;;
        --config)     ACTION="config"; shift ;;
        --models)     ACTION="models"; shift ;;
        --logs)       ACTION="logs"; shift ;;
        --status)     ACTION="status"; shift ;;
        --stop)       ACTION="stop"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        *)            shift ;;
    esac
done
BASE_URL="http://127.0.0.1:$PORT/v1"
init_logs

case "$ACTION" in
help)   sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
stop)   if stop_proxy; then echo "stopped VS Code proxy on 127.0.0.1:$PORT"; else echo "no VS Code proxy on 127.0.0.1:$PORT"; fi; exit 0 ;;
status) curl -fsS "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null && echo || { echo "no deepcopilot proxy on 127.0.0.1:$PORT"; exit 1; }; exit 0 ;;
models) list_models || { echo "no proxy on 127.0.0.1:$PORT (start it: copilot-vscode -b $BACKEND)" >&2; exit 1; }; exit 0 ;;
logs)   [[ -f "$REQUEST_LOG" ]] || { echo "no request log yet ($REQUEST_LOG). Use Copilot in VS Code once."; exit 1; }; tail -n 40 -f "$REQUEST_LOG"; exit 0 ;;
config)
    cat <<EOF
VS Code setup — Copilot's built-in "Ollama" provider, replaced by deepcopilot:

  1. Start the proxy:   copilot-vscode -b $BACKEND     (runs detached)
  2. VS Code: Chat model picker -> Manage Models -> Ollama. Your models appear; enable them.
  3. Pick one. Switching the picked model switches provider live — no restart.

Default port 11434 matches Copilot's Ollama endpoint, so no extra setting is
needed. On another port also run:  copilot-vscode --setup
EOF
    exit 0 ;;
setup)
    SETTINGS="$HOME/.config/Code/User/settings.json"
    [[ -f "$SETTINGS" ]] || { mkdir -p "$(dirname "$SETTINGS")"; echo '{}' > "$SETTINGS"; }
    node -e '
      const fs=require("fs"), f=process.argv[1], url=process.argv[2];
      let raw=fs.readFileSync(f,"utf8"), j;
      try{ j=JSON.parse(raw||"{}"); }catch(e){ console.error("settings.json is not valid JSON; edit it manually."); process.exit(1); }
      j["github.copilot.chat.byok.ollamaEndpoint"]=url;
      fs.writeFileSync(f, JSON.stringify(j,null,2));
      console.log("Set github.copilot.chat.byok.ollamaEndpoint = "+url+" in "+f);
    ' "$SETTINGS" "http://127.0.0.1:$PORT" || exit 1
    echo "Now start the proxy (copilot-vscode -b $BACKEND), then enable your models in VS Code."
    exit 0 ;;
esac

command -v node >/dev/null || { echo "node is required (>=18)"; exit 1; }

# Daemon: start the proxy DETACHED so it outlives this terminal (VS Code needs
# a long-lived Ollama endpoint). Replace any stale proxy on the port first.
stop_proxy >/dev/null 2>&1 || true
setsid node "$SCRIPT_DIR/proxy/start-proxy.js" "$BACKEND" "$PORT" >"$PROXY_LOG" 2>&1 < /dev/null &
if wait_health ""; then
    echo "[deepcopilot] proxy running (detached) on $BASE_URL  backend=$BACKEND"
    echo "[deepcopilot] survives terminal close. stop: copilot-vscode --stop | logs: copilot-vscode --logs"
    echo "[deepcopilot] VS Code: enable your models in Manage Models -> Ollama (copilot-vscode --config)"
    exit 0
fi
exit 1
