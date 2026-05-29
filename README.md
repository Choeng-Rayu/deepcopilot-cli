# deepcopilot

Run **GitHub Copilot** — both the **VS Code** extension and the **Copilot CLI** — on **Nvidia NIM**, **DeepSeek**, or **Kimi-for-coding** instead of GitHub-hosted models. Switch between providers **live, with no restart**.

> Sister project to [deepclaude-cli](https://github.com/d-kuro/deepclaude-cli) and deepantigravity-cli. Same idea, but Copilot has **native BYOK**, so no TLS-MITM, certs, sudo, or `/etc/hosts` hacks are needed — just a small local router.

---

## How it works

Copilot supports "bring your own key" (BYOK) against any OpenAI-compatible endpoint. deepcopilot runs a tiny local router proxy and points Copilot at it:

```
Copilot (VS Code / CLI)  ──OpenAI Chat Completions──►  127.0.0.1:11434 (deepcopilot)
                                                            │  routes by the requested model
                                   ┌────────────────────────┼────────────────────────┐
                                   ▼                         ▼                         ▼
                            Nvidia NIM                  DeepSeek                 Kimi-for-coding
                          (OpenAI passthrough)     (OpenAI passthrough)      (translated OpenAI⇄Anthropic)
```

Each provider is one model in the picker. Selecting a different model = a different provider, **instantly**, because routing happens per request inside the proxy.

| Backend | Wire format | Handling |
|---|---|---|
| **Nvidia NIM** | OpenAI Chat Completions | transparent passthrough |
| **DeepSeek** | OpenAI Chat Completions | transparent passthrough |
| **Kimi-for-coding** | Anthropic Messages (`/v1/messages`) | translated both ways |

---

## Setup

Requires **Node.js ≥ 18**.

```bash
cd deepcopilot-cli
cp proxy/.env.example proxy/.env
nano proxy/.env        # add a key for any provider(s) you want
chmod +x deepcopilot.sh
```

`proxy/.env` (fill in only what you need):

```ini
API_PROVIDER=nvidia          # default backend / the "auto" target
DEEPCOPILOT_PORT=11434

NVIDIA_API_KEY=nvapi-...      # https://build.nvidia.com
NVIDIA_MODEL=moonshotai/kimi-k2.6

DEEPSEEK_API_KEY=sk-...       # https://platform.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro

KIMI_API_KEY=sk-...           # https://www.kimi.com/code/console  (Kimi *for coding*)
KIMI_MODEL=kimi-for-coding
```

Only backends with a real key are activated; placeholder values are skipped.

---

## Use with Copilot CLI

```bash
./deepcopilot.sh                 # default backend from API_PROVIDER
./deepcopilot.sh -b deepseek     # start on DeepSeek
./deepcopilot.sh -b kimi -- --help    # args after -- go to `copilot`
```

This starts the proxy, exports the Copilot BYOK env vars, and launches `copilot`. If `copilot` isn't installed it leaves the proxy running and tells you the base URL.

### Switch provider live (no restart)

The CLI selects a model per session. Two ways to switch without restarting the proxy:

- Set the model when launching a session: `COPILOT_MODEL=deepseek copilot` (the proxy is already running).
- Repoint the **`auto`** alias at runtime, affecting new requests that use model `auto`:

```bash
curl -s -XPOST http://127.0.0.1:11434/_proxy/mode -d backend=kimi
```

Use `--model nvidia|deepseek|kimi` (or the real model id) inside Copilot to pin a specific provider.

---

## Use with VS Code

On **stable** VS Code, Copilot's native "Custom Endpoint" provider is disabled
(it's gated to Insiders builds). So deepcopilot **impersonates Ollama**: it
speaks the Ollama API and listens on Ollama's default port (`11434`). Copilot's
built-in **Ollama** provider points at `http://localhost:11434` out of the box,
so deepcopilot simply **takes Ollama's place** — no endpoint config needed.

1. Start the proxy and leave it running:

   ```bash
   ./deepcopilot.sh -b nvidia
   ```

2. In VS Code: open the Chat **model picker → Manage Models → Ollama**. Your
   configured backends (nvidia / deepseek / kimi) show up there — enable them.

3. Pick one in the model picker. **Switching the picked model switches provider
   live** — no restart.

That's it. The proxy answers Ollama's discovery calls (`/api/version`,
`/api/tags`, `/api/show`) and chats via `/v1/chat/completions`.

**If you actually run real Ollama** (or use a non-default port), set
`DEEPCOPILOT_PORT` to something else and point Copilot at it:

```bash
./deepcopilot.sh --vscode-setup     # writes:
# "github.copilot.chat.byok.ollamaEndpoint": "http://127.0.0.1:<port>"
```

Run `./deepcopilot.sh --vscode-config` to print these steps anytime.

> BYOK applies to Copilot **chat/agent**, not inline code completions (a GitHub
> limitation). Models are advertised with tool-calling enabled so agent mode works.

---

## Control endpoints

The proxy (default `127.0.0.1:11434`) exposes:

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness check |
| `GET /v1/models` | list routable models (per backend + `auto`) |
| `GET /_proxy/status` | configured backends, default backend, request stats |
| `POST /_proxy/mode` | switch the default/`auto` backend (`-d backend=deepseek`) |
| `POST /v1/chat/completions` | the OpenAI endpoint Copilot calls |
| `GET /api/version`, `GET /api/tags`, `POST /api/show` | Ollama-API emulation, so VS Code's Ollama provider can discover the models |

Check status anytime: `./deepcopilot.sh --status`

---

## Security

- The proxy binds to **`127.0.0.1` only** and has **no authentication** — anything that can reach the port can use your provider keys. Don't bind it to `0.0.0.0` or expose it through a tunnel.
- Provider keys live in `proxy/.env` (gitignored). The `apiKey` Copilot sends to the proxy is a placeholder; the **real** key is attached by the proxy when it calls the upstream provider.
- Prompts and code context are sent to whichever provider you select. Consider the data-handling implications of each provider before using it on private code.

---

## Project structure

```
deepcopilot-cli/
├── deepcopilot.sh              # launcher (starts proxy + Copilot CLI)
├── proxy/
│   ├── .env.example            # config template
│   ├── package.json            # ESM, zero dependencies
│   ├── router-proxy.js         # HTTP server + model-based routing + control endpoints
│   ├── openai-anthropic.js     # OpenAI⇄Anthropic translator (Kimi path)
│   └── start-proxy.js          # entry point (loads .env, builds backends)
└── README.md
```

## License

MIT
