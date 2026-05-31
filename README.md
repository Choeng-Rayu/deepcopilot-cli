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

Each provider can expose one or more models in the picker. Selecting any model
routes to its provider **instantly**, because routing happens per request inside
the proxy.

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
# Expose several Nvidia models in the picker (comma-separated). All route
# to Nvidia; the selected id is forwarded upstream unchanged.
NVIDIA_MODELS=moonshotai/kimi-k2.6, qwen/qwen3-coder-480b-a35b-instruct, openai/gpt-oss-120b

DEEPSEEK_API_KEY=sk-...       # https://platform.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_MODELS=deepseek-v4-pro, deepseek-v4-flash

KIMI_API_KEY=sk-...           # https://www.kimi.com/code/console  (Kimi *for coding*)
KIMI_MODEL=kimi-for-coding
```

Only backends with a real key are activated; placeholder values are skipped.
Each provider can expose **multiple models** via `<PROVIDER>_MODELS` (a
comma-separated list). Every listed model shows up in Copilot's picker and
routes to that provider; `<PROVIDER>_MODEL` is the primary (used for the
backend-name alias and `auto`). Browse available ids at the provider's
`/v1/models` endpoint (e.g. `https://integrate.api.nvidia.com/v1/models`).

---

## Use with Copilot CLI

```bash
./deepcopilot.sh                                  # default backend from API_PROVIDER
./deepcopilot.sh -b nvidia -m nvidia__nemotron-3-super-120b-a12b   # pick a model
./deepcopilot.sh --models                         # list model ids you can pass to -m
./deepcopilot.sh -b kimi -- --help                # args after -- go to `copilot`
```

This starts the proxy, exports the Copilot BYOK env vars (including the model's
real context window), and launches `copilot`. If `copilot` isn't installed it
leaves the proxy running and tells you the base URL.

### Choosing the model (important: the CLI is one model per session)

The GitHub Copilot CLI's BYOK mode is **hardcoded to a single model** — its
interactive `/model` command only ever shows the one model you launched with,
and it never queries the proxy's model list. (This is a CLI limitation: it has
only `openai`/`azure`/`anthropic` provider types, no multi-model Ollama
provider. **VS Code does** show all models because it has an Ollama provider —
see the VS Code section.)

So to use a different model in the CLI, **relaunch** with `-m`:

```bash
./deepcopilot.sh -b nvidia -m qwen__qwen3-coder-480b-a35b-instruct
```

`-m` sets the model, its real context window, and identity for that session.
Run `./deepcopilot.sh --models` for the exact ids. A wrong/typo'd model now
returns a clear error instead of silently using the default.

> The proxy's `auto` alias and `POST /_proxy/mode` still let you repoint the
> default backend at runtime, but the CLI sends a fixed model per session, so
> `-m` (relaunch) is the reliable switch for the CLI.

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

2. In VS Code: open the Chat **model picker → Manage Models → Ollama**. This
   shows a **multi-select list of every model** the proxy exposes. **Check ALL
   the ones you want** — VS Code only adds the *checked* models to the picker,
   so if you tick just one, you'll see only one. Run `./deepcopilot.sh --models`
   to print the exact ids to look for (they use `__` instead of `/`).

3. Pick one in the model picker. **Switching the picked model switches provider
   live** — no restart.

> **Model ids with `/` are auto-aliased.** Copilot builds an internal
> `ollama/Ollama/<model>` id and splits it on `/`, so a provider id like
> `stepfun-ai/step-3.7-flash` would break ("Chat provider … is not
> registered" / only one model shows). The proxy therefore advertises a
> slash-free alias (`stepfun-ai__step-3.7-flash`) and maps it back to the
> real id when calling the provider. You'll see the `__` form in the picker;
> that's expected.

> **The proxy must stay running** the whole time you use these models in
> Copilot. If you stop it (or close its terminal), requests fail with
> "Unable to verify Ollama server version" / connection errors. After
> starting/restarting the proxy or changing models, **reload the VS Code
> window** (Command Palette → "Developer: Reload Window") so Copilot
> re-discovers the models.

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

### VS Code troubleshooting

**"Unable to verify Ollama server version."** This generic error is thrown on
*any* failure to reach `<endpoint>/api/version`. Check, in order:

1. The proxy is running on the expected port (`./deepcopilot.sh --status`).
2. `github.copilot.chat.byok.ollamaEndpoint` points at that port
   (default `http://127.0.0.1:11434`). Use `127.0.0.1`, not `localhost`.
3. There is **no leftover `Ollama` entry in
   `~/.config/Code/User/chatLanguageModels.json`** pointing at a different /
   old port. If both that file *and* the `ollamaEndpoint` setting define
   Ollama, you also get **"Language model group with name Ollama already
   exists for vendor ollama"**. Keep only one — the `ollamaEndpoint` setting —
   and remove the `{"vendor":"ollama",...}` block from that file.
4. After fixing, do a **full VS Code restart** (quit and reopen, not just
   "Reload Window") to clear the in-memory duplicate registration.

The proxy binds both `127.0.0.1` and `::1`, so either resolution of
`localhost` works.

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

- The proxy binds to **loopback only** (`127.0.0.1` and `::1`, so `localhost` works over both IPv4 and IPv6) and has **no authentication** — anything that can reach the port can use your provider keys. Don't bind it to a public interface or expose it through a tunnel.
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
