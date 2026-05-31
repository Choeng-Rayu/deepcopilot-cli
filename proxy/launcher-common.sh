# deepcopilot launcher shared helpers (sourced by copilot-cli.sh / copilot-vscode.sh).
# Requires SCRIPT_DIR and PORT to be set by the caller. Provides per-surface
# logging under proxy/.cache/<SURFACE>/ so each launcher's issues are isolated.

# Load proxy/.env without overriding already-set vars.
load_env() {
    local f="$SCRIPT_DIR/proxy/.env"
    [[ -f "$f" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        line="${line%%#*}"; line="$(echo "$line" | xargs)"
        [[ -z "$line" ]] && continue
        local key="${line%%=*}"
        [[ -z "${!key:-}" ]] && export "$line"
    done < "$f"
}

# Per-surface cache dir + log paths. SURFACE is "cli" or "vscode".
init_logs() {
    LOG_DIR="$SCRIPT_DIR/proxy/.cache/$SURFACE"
    mkdir -p "$LOG_DIR"
    PROXY_LOG="$LOG_DIR/proxy.log"          # proxy stdout/stderr (startup, errors)
    REQUEST_LOG="$LOG_DIR/requests.log"     # each upstream request (what the client called)
    PIDFILE="$LOG_DIR/proxy.pid"
    export DEEPCOPILOT_REQUEST_LOG="$REQUEST_LOG"
}

# Stop a deepcopilot proxy bound to $PORT. Verifies via /_proxy/status so we
# never kill an unrelated server; falls back to the surface PID file.
stop_proxy() {
    local status pid=""
    status="$(curl -fsS --max-time 1 "http://127.0.0.1:$PORT/_proxy/status" 2>/dev/null || true)"
    if [[ -n "$status" ]]; then
        grep -q '"deepcopilot":true' <<<"$status" || { echo "[deepcopilot] port $PORT held by a non-deepcopilot server; not touching it." >&2; return 2; }
        pid="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).pid||""))}catch{}})' <<<"$status")"
    fi
    [[ -z "$pid" && -f "$PIDFILE" ]] && pid="$(cat "$PIDFILE" 2>/dev/null)"
    [[ -z "$pid" ]] && return 1
    kill -CONT "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"; sleep 0.2; return 0
}

# Block until the proxy answers /health, or fail with the log. $1 = PID to watch.
wait_health() {
    local pid="$1"
    for _ in $(seq 1 150); do
        curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
        [[ -n "$pid" ]] && { kill -0 "$pid" 2>/dev/null || { echo "[deepcopilot] proxy failed to start:" >&2; tail -20 "$PROXY_LOG" >&2; return 1; }; }
        sleep 0.1
    done
    echo "[deepcopilot] proxy not ready after 15s; see $PROXY_LOG" >&2; tail -20 "$PROXY_LOG" >&2; return 1
}

# List model ids the proxy serves (slash-free aliases).
list_models() {
    curl -fsS "http://127.0.0.1:$PORT/api/tags" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const m of JSON.parse(s).models)console.log(m.model)}catch{process.exit(1)}})'
}

# Follow a log file live. Uses --use-polling to avoid "inotify watch limit
# reached" (common when VS Code is running); falls back to plain -f. $1=file, $2=initial lines.
live_tail() {
    local f="$1" n="${2:-40}"
    tail -n "$n" --use-polling -f "$f" 2>/dev/null || tail -n "$n" -f "$f"
}
