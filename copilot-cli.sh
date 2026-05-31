#!/usr/bin/env bash
# copilot-cli — Run GitHub Copilot CLI on Nvidia/DeepSeek/Kimi via the local proxy.
#
# The CLI uses ONE model per session (BYOK has no live model picker). Pick it
# with -m; switch by relaunching. Logs are isolated under proxy/.cache/cli/.
#
# Usage:
#   copilot-cli [-b nvidia|deepseek|kimi] [-m MODEL] [--port N] [-- copilot-args]
#   copilot-cli --models     # list model ids you can pass to -m
#   copilot-cli --logs       # tail this CLI session's request log
#   copilot-cli --status     # show the running proxy status
#   copilot-cli --stop       # stop the CLI proxy on this port
#   copilot-cli --help

set -euo pipefail

_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"; _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"; unset _SOURCE _DIR

SURFACE="cli"
source "$SCRIPT_DIR/proxy/launcher-common.sh"
load_env

PORT="${DEEPCOPILOT_PORT:-11434}"
BACKEND="${API_PROVIDER:-nvidia}"
MODEL=""
ACTION="launch"
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --model|-m)   MODEL="$2"; shift 2 ;;
        --port)       PORT="$2"; shift 2 ;;
        --models)     ACTION="models"; shift ;;
        --logs)       ACTION="logs"; shift ;;
        --status)     ACTION="status"; shift ;;
        --stop)       ACTION="stop"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        --)           shift; PASS_ARGS+=("$@"); break ;;
        *)            PASS_ARGS+=("$1"); shift ;;
    esac
done
BASE_URL="http://127.0.0.1:$PORT/v1"
init_logs

case "$ACTION" in
help)   sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
stop)   if stop_proxy; then echo "stopped CLI proxy on 127.0.0.1:$PORT"; else echo "no CLI proxy on 127.0.0.1:$PORT"; fi; exit 0 ;;
status) curl -fsS "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null && echo || { echo "no deepcopilot proxy on 127.0.0.1:$PORT"; exit 1; }; exit 0 ;;
models) list_models || { echo "no proxy on 127.0.0.1:$PORT (start it: copilot-cli -b $BACKEND)" >&2; exit 1; }; exit 0 ;;
logs)   [[ -f "$REQUEST_LOG" ]] || { echo "no request log yet ($REQUEST_LOG). Start a session first."; exit 1; }; live_tail "$REQUEST_LOG" 40; exit 0 ;;
esac

command -v node >/dev/null || { echo "node is required (>=18)"; exit 1; }

# Replace any stale CLI proxy on this port, then start one tied to this terminal.
stop_proxy >/dev/null 2>&1 || true
setsid node "$SCRIPT_DIR/proxy/start-proxy.js" "$BACKEND" "$PORT" >"$PROXY_LOG" 2>&1 < /dev/null &
PROXY_PID=$!
cleanup() { kill "$PROXY_PID" 2>/dev/null || true; rm -f "$PIDFILE"; }
trap cleanup EXIT INT TERM

wait_health "$PROXY_PID" || exit 1
echo "[deepcopilot] proxy on $BASE_URL  (backend: $BACKEND, logs: $LOG_DIR)" >&2

# Hand off to Copilot CLI via BYOK env.
export COPILOT_PROVIDER_BASE_URL="$BASE_URL"
export COPILOT_PROVIDER_TYPE="openai"
export COPILOT_PROVIDER_API_KEY="deepcopilot"   # enforced upstream by the proxy
if [[ -n "$MODEL" ]]; then
    COPILOT_MODEL="$MODEL"
    if ! curl -fsS "http://127.0.0.1:$PORT/v1/models" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const ids=JSON.parse(s).data.map(m=>m.id);process.exit(ids.includes(process.argv[1])?0:1)}catch{process.exit(1)}})' "$MODEL"; then
        echo "[deepcopilot] WARNING: model '$MODEL' not in the proxy list (copilot-cli --models). Using it anyway." >&2
    fi
elif [[ -z "${COPILOT_MODEL:-}" ]]; then
    COPILOT_MODEL="$(curl -fsS "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.backends?.[j.defaultBackend]?.model||"")}catch{}})' 2>/dev/null)"
    [[ -z "$COPILOT_MODEL" ]] && COPILOT_MODEL="$BACKEND"
fi
export COPILOT_MODEL
export COPILOT_PROVIDER_MODEL_ID="$COPILOT_MODEL"
# Real context window; otherwise the CLI defaults to 128k.
CTX="$(curl -fsS -XPOST "http://127.0.0.1:$PORT/api/show" -d "{\"model\":\"$COPILOT_MODEL\"}" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const mi=JSON.parse(s).model_info||{};const a=mi["general.architecture"];process.stdout.write(String(mi[a+".context_length"]||""))}catch{}})' 2>/dev/null)"
if [[ "$CTX" =~ ^[0-9]+$ ]]; then
    export COPILOT_PROVIDER_MAX_PROMPT_TOKENS="$CTX"
    [[ -z "${COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:-}" ]] && export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS="16384"
    echo "[deepcopilot] CLI model: $COPILOT_MODEL  (context: $CTX tokens; change with -m <model>)" >&2
else
    echo "[deepcopilot] CLI model: $COPILOT_MODEL  (change with -m <model>; list: copilot-cli --models)" >&2
fi

if ! command -v copilot >/dev/null; then
    echo "[deepcopilot] 'copilot' CLI not found. Proxy is running at $BASE_URL." >&2
    echo "[deepcopilot] Install: npm i -g @github/copilot   then re-run. Ctrl-C to stop the proxy." >&2
    wait "$PROXY_PID"; exit 0
fi

copilot --model "$COPILOT_MODEL" "${PASS_ARGS[@]}"
