#!/usr/bin/env bash
# deepcopilot — Run GitHub Copilot CLI on Nvidia NIM, DeepSeek, or Kimi-for-coding.
#
# How it works:
#   Starts a local OpenAI-compatible router proxy (127.0.0.1) and points
#   Copilot CLI at it via BYOK env vars. The proxy routes each request to
#   a backend based on the requested model, so switching models switches
#   providers with no restart.
#
# Usage:
#   deepcopilot [-b nvidia|deepseek|kimi] [--port N] [-- copilot-args]
#   deepcopilot --daemon [-b ...]  # start proxy DETACHED (for VS Code); survives terminal
#   deepcopilot --status          # show running proxy status
#   deepcopilot --models          # list model ids to enable in VS Code
#   deepcopilot --logs            # tail proxy requests (see what VS Code calls)
#   deepcopilot --stop            # stop the proxy running on this port
#   deepcopilot --vscode-setup    # point VS Code Copilot at the proxy (Ollama provider)
#   deepcopilot --vscode-config   # print manual VS Code steps
#   deepcopilot --help

set -euo pipefail

# ── Resolve symlinks ──
_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
    _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
unset _SOURCE _DIR

ENV_FILE="$SCRIPT_DIR/proxy/.env"

# ── Load .env (no override of already-set vars) ──
if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        line="${line%%#*}"; line="$(echo "$line" | xargs)"
        [[ -z "$line" ]] && continue
        key="${line%%=*}"
        [[ -z "${!key:-}" ]] && export "$line"
    done < "$ENV_FILE"
fi

PORT="${DEEPCOPILOT_PORT:-11434}"
BACKEND="${API_PROVIDER:-nvidia}"
ACTION="launch"
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b)          BACKEND="$2"; shift 2 ;;
        --port)                PORT="$2"; shift 2 ;;
        --daemon|--start)      ACTION="daemon"; shift ;;
        --status)              ACTION="status"; shift ;;
        --models)              ACTION="models"; shift ;;
        --logs)                ACTION="logs"; shift ;;
        --stop)                ACTION="stop"; shift ;;
        --vscode-setup)        ACTION="vscode-setup"; shift ;;
        --vscode-config)       ACTION="vscode-config"; shift ;;
        --help|-h)             ACTION="help"; shift ;;
        --)                    shift; PASS_ARGS+=("$@"); break ;;
        *)                     PASS_ARGS+=("$1"); shift ;;
    esac
done
BASE_URL="http://127.0.0.1:$PORT/v1"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

# Stop any deepcopilot proxy currently bound to $PORT. Identifies it via
# /_proxy/status (which reports {deepcopilot:true,pid}) so we never kill an
# unrelated server, then waits for the socket to free.
stop_proxy() {
    local status pid="" PIDFILE="$SCRIPT_DIR/proxy/.cache/proxy.pid"
    status="$(curl -fsS --max-time 1 "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null || true)"
    if [[ -n "$status" ]]; then
        if ! grep -q '"deepcopilot":true' <<<"$status"; then
            echo "[deepcopilot] port $PORT is held by a non-deepcopilot server; not touching it." >&2
            return 2
        fi
        pid="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).pid||""))}catch{}})' <<<"$status")"
    fi
    # Fallback: a frozen proxy (e.g. after Ctrl-Z) still holds the port but
    # can't answer HTTP. Use the PID file written at startup.
    [[ -z "$pid" && -f "$PIDFILE" ]] && pid="$(cat "$PIDFILE" 2>/dev/null)"
    [[ -z "$pid" ]] && return 1
    kill -CONT "$pid" 2>/dev/null || true   # un-freeze a suspended proxy so it can exit
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true      # last resort
    rm -f "$PIDFILE"
    sleep 0.2
    return 0
}

case "$ACTION" in
help)   usage; exit 0 ;;
stop)
    if stop_proxy; then echo "stopped deepcopilot proxy on 127.0.0.1:$PORT"
    else echo "no deepcopilot proxy on 127.0.0.1:$PORT"; fi
    exit 0 ;;
status)
    if curl -fsS "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null; then echo
    else echo "no deepcopilot proxy responding on 127.0.0.1:$PORT"; exit 1; fi
    exit 0 ;;
models)
    # List the model ids exactly as they appear in Copilot's picker (the
    # slash-free aliases). Enable these in Manage Models -> Ollama.
    if ! curl -fsS "http://127.0.0.1:$PORT/api/tags" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const m of JSON.parse(s).models)console.log(m.model)}catch{process.exit(1)}})'; then
        echo "no deepcopilot proxy on 127.0.0.1:$PORT (start it: deepcopilot -b $BACKEND)" >&2; exit 1
    fi
    exit 0 ;;
logs)
    # Show what VS Code / clients are calling on the proxy.
    LOG="$SCRIPT_DIR/proxy/.cache/requests.log"
    [[ -f "$LOG" ]] || { echo "no request log yet ($LOG). Start the proxy and use it once."; exit 1; }
    tail -n 40 -f "$LOG"
    exit 0 ;;
vscode-config)
    cat <<EOF
VS Code (stable) setup — Copilot's built-in "Ollama" provider, replaced by deepcopilot:

  1. Start the proxy:   deepcopilot -b $BACKEND      (leave it running)
  2. In VS Code: open the Chat model picker -> Manage Models -> Ollama.
     Your models (nvidia/deepseek/kimi) appear there; enable them.
  3. Pick one in the model picker. Switching the picked model switches
     provider live — no restart.

Port $PORT: Copilot's Ollama provider points at http://localhost:11434 by
default, so on the default port no extra setting is needed — deepcopilot just
takes Ollama's place. If you run on a different port, also run:
  deepcopilot --vscode-setup
(sets "github.copilot.chat.byok.ollamaEndpoint": "http://127.0.0.1:$PORT").

Note: the native "Custom Endpoint" provider is disabled on stable VS Code, so
we impersonate Ollama (its provider accepts any base URL). BYOK applies to
Copilot chat/agent, not inline completions.
EOF
    exit 0 ;;
vscode-setup)
    # Write github.copilot.chat.byok.ollamaEndpoint into VS Code user settings.
    SETTINGS="$HOME/.config/Code/User/settings.json"
    [[ -f "$SETTINGS" ]] || { mkdir -p "$(dirname "$SETTINGS")"; echo '{}' > "$SETTINGS"; }
    node -e '
      const fs=require("fs"), f=process.argv[1], url=process.argv[2];
      let raw=fs.readFileSync(f,"utf8");
      // tolerate empty file
      let j; try{ j=JSON.parse(raw||"{}"); }catch(e){ console.error("settings.json is not valid JSON; edit it manually to add the ollamaEndpoint key."); process.exit(1); }
      j["github.copilot.chat.byok.ollamaEndpoint"]=url;
      fs.writeFileSync(f, JSON.stringify(j,null,2));
      console.log("Set github.copilot.chat.byok.ollamaEndpoint = "+url+" in "+f);
    ' "$SETTINGS" "http://127.0.0.1:$PORT" || exit 1
    echo "Now: start the proxy (deepcopilot -b $BACKEND), then in VS Code: Chat model picker -> Manage Models -> Ollama -> enable your models."
    exit 0 ;;
esac

command -v node >/dev/null || { echo "node is required (>=18)"; exit 1; }

# ── Replace any stale deepcopilot proxy on this port (reliable restart) ──
# A previous session whose terminal was closed can leave a proxy bound to
# the port. It would keep answering /health (so we'd think we're up) while
# the new proxy fails to bind. Detect and stop it first.
stop_proxy >/dev/null 2>&1 || true

# ── Daemon mode: start the proxy DETACHED so it survives this terminal ──
# This is what VS Code needs — a long-lived Ollama endpoint on the port.
if [[ "$ACTION" == "daemon" ]]; then
    DLOG="$SCRIPT_DIR/proxy/.cache/proxy.log"
    mkdir -p "$(dirname "$DLOG")"
    setsid node "$SCRIPT_DIR/proxy/start-proxy.js" "$BACKEND" "$PORT" >"$DLOG" 2>&1 < /dev/null &
    for _ in $(seq 1 80); do
        curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
        sleep 0.1
    done
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
        echo "[deepcopilot] proxy running (detached) on $BASE_URL  backend=$BACKEND"
        echo "[deepcopilot] it will keep running after you close this terminal."
        echo "[deepcopilot] stop with: deepcopilot --stop   | logs: deepcopilot --logs"
        exit 0
    fi
    echo "[deepcopilot] proxy failed to start; see $DLOG" >&2; tail -5 "$DLOG" >&2; exit 1
fi

# ── Start the proxy (background, tied to this terminal) ──
# setsid → own session/process group, so Ctrl-Z (suspend) or Ctrl-C on the
# foreground `copilot` does NOT freeze/kill the proxy. The cleanup trap below
# still stops it when this launcher actually exits.
PROXY_LOG="$(mktemp -t deepcopilot.XXXXXX.log)"
setsid node "$SCRIPT_DIR/proxy/start-proxy.js" "$BACKEND" "$PORT" >"$PROXY_LOG" 2>>"$PROXY_LOG" < /dev/null &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; rm -f "$PROXY_LOG" "$SCRIPT_DIR/proxy/.cache/proxy.pid"; }
trap cleanup EXIT INT TERM

# ── Wait for health ──
for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    kill -0 "$PROXY_PID" 2>/dev/null || { echo "proxy failed to start:"; cat "$PROXY_LOG"; exit 1; }
    sleep 0.1
done

echo "[deepcopilot] proxy on $BASE_URL  (default backend: $BACKEND)" >&2
echo "[deepcopilot] switch live in a session with COPILOT_MODEL=nvidia|deepseek|kimi, or:" >&2
echo "              curl -s -XPOST http://127.0.0.1:$PORT/_proxy/mode -d backend=deepseek   (changes the 'auto' target)" >&2

# ── Hand off to Copilot CLI via BYOK env ──
export COPILOT_PROVIDER_BASE_URL="$BASE_URL"
export COPILOT_PROVIDER_TYPE="openai"
export COPILOT_PROVIDER_API_KEY="deepcopilot"   # key is enforced upstream by the proxy
# Default the model to the chosen backend's PRIMARY model id (the backend
# name also works as an alias, but a real id is clearer in `copilot`).
if [[ -z "${COPILOT_MODEL:-}" ]]; then
    COPILOT_MODEL="$(curl -fsS "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.backends?.[j.defaultBackend]?.model||"")}catch{}})' 2>/dev/null)"
    [[ -z "$COPILOT_MODEL" ]] && COPILOT_MODEL="$BACKEND"
fi
export COPILOT_MODEL

if ! command -v copilot >/dev/null; then
    echo "[deepcopilot] 'copilot' CLI not found. Proxy is running at $BASE_URL." >&2
    echo "[deepcopilot] Install: npm i -g @github/copilot   then re-run, or use VS Code (--print-vscode-config)." >&2
    echo "[deepcopilot] Ctrl-C to stop the proxy." >&2
    wait "$PROXY_PID"
    exit 0
fi

copilot "${PASS_ARGS[@]}"
