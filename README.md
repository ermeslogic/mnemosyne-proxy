# Mnemosyne Proxy

[Documentazione in italiano](README.it.md)

Mnemosyne Proxy is a local memory and privacy proxy for OpenAI-compatible chat. It adds relevant project memories to requests, pseudonymizes detected sensitive text, and restores the original values in JSON and streamed responses. SQLite stores memories on your machine, and Ollama handles entity detection and fact extraction locally.

## Getting started on Windows

Use [Node.js 24 LTS](https://nodejs.org/en/download) version 24.12 or later and [Ollama](https://ollama.com/download/windows). Open PowerShell and check `node --version`. Run `ollama pull` only if the model is missing from `ollama list`.

```powershell
git clone https://github.com/ermeslogic/mnemosyne-proxy.git
Set-Location .\mnemosyne-proxy
npm.cmd install --offline --no-audit
npm.cmd run db:init
npm.cmd test
ollama pull qwen2.5-coder:1.5b
```

If PowerShell cannot find `ollama`, use `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"` in its place.

To run Ollama in local-only mode, close any running instance in the system tray. Start it in a separate terminal and check the log to confirm that cloud features are disabled. To persist this setting, set `disable_ollama_cloud` to `true` in `~/.ollama/server.json`.

```powershell
$env:OLLAMA_NO_CLOUD = '1'
ollama serve
```

Start Mnemosyne Proxy in a second terminal opened in the project directory. On first startup, it creates the SQLite database if needed.

```powershell
npm.cmd start
```

Set your client's base URL to `http://127.0.0.1:8787/v1` and its model to `qwen2.5-coder:1.5b`. If the client requires an API key and `MN_CLIENT_KEY` is unset, use any placeholder value, such as `local`.

## Test with curl

```powershell
curl.exe -fsS http://127.0.0.1:8787/health
curl.exe -fsS http://127.0.0.1:8787/v1/models
$mnBody = '{"model":"qwen2.5-coder:1.5b","stream":true,"max_tokens":80,"messages":[{"role":"user","content":"Reply with my name only. My name is Jane Doe."}]}'
$mnBody | curl.exe -sS -N http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' -H 'X-Context-Namespace: demo' -H 'X-Context-Session: test-1' --data-binary '@-'
```

The response uses `text/event-stream` and ends with `data: [DONE]`. If the model repeats the placeholder, the client receives `Jane Doe`. If you configured `MN_CLIENT_KEY`, add `-H "Authorization: Bearer $env:MN_CLIENT_KEY"` to each call.

To test memory updates, send `We use MySQL as our database.` and then `Switched our database from MySQL to PostgreSQL.` in separate requests with the same namespace. Allow the worker to process each turn before querying the result. Ask `Which database does this project use?` in the `demo` namespace and then in `other-project`. Only the `demo` request receives the stored PostgreSQL fact. `npm.cmd test` checks the two database states using mock HTTP servers and needs neither Ollama nor credentials.

## Providers

Set `MN_UPSTREAM_BASE_URL` before starting the proxy. Choose a model available from that provider. Ollama still runs locally for privacy checks and memory extraction when the upstream model is remote.

| Provider | `MN_UPSTREAM_BASE_URL` | Credentials |
|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | None for the default configuration |
| llama.cpp | `http://127.0.0.1:8080/v1` | The `llama-server` API key, if configured |
| OpenAI | `https://api.openai.com/v1` | `MN_UPSTREAM_API_KEY` |
| Anthropic | `https://api.anthropic.com/v1` | `MN_UPSTREAM_API_KEY` and `MN_ANTHROPIC_WORKSPACE` if the key requires it |

Mnemosyne uses Anthropic's Chat Completions compatibility endpoint. Available options depend on the upstream provider and model. The proxy serves `POST /v1/chat/completions` for text messages, `GET /v1/models` for model discovery, and `GET /health` for the SQLite worker's status.

| Variable | Default | Purpose |
|---|---|---|
| `MN_PORT` | `8787` | Port bound to `127.0.0.1` |
| `MN_DB_PATH` | `data/mnemosyne.sqlite` | SQLite database path |
| `MN_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `MN_LOCAL_MODEL` | `qwen2.5-coder:1.5b` | Local model for named entity recognition (NER) and fact extraction |
| `MN_CLIENT_KEY` | Unset | Optional local bearer token, separate from the upstream API key |
| `MN_NER_MODE` | `required` | `heuristic` uses rule-based detection only and requires a loopback upstream |
| `MN_PRIVACY_TIMEOUT_MS` | `90000` | NER time budget, including cold starts and batching |
| `MN_MEMORY_TIMEOUT_MS` | `90000` | Time budget for post-response fact extraction |
| `MN_UPSTREAM_TIMEOUT_MS` | `180000` | Time budget for the full upstream response or stream |
| `MN_DECAY_PER_DAY` | `0.035` | Daily decay rate for new memories |
| `MN_RETRIEVAL_BELOW` | `0.55` | Minimum score for adding a memory to a prompt |
| `MN_ARCHIVE_BELOW` | `0.25` | Minimum remaining strength before archival |

## Namespaces and memory

- `X-Context-Namespace` selects the project. When the header is missing, the proxy classifies the latest message as `coding`, `business`, or `personal` if the signals point to a clear category. Automatic categories are shared across the instance. Use explicit namespaces to keep projects in the same category separate.
- For ambiguous turns, supply `X-Context-Session` to carry memory across requests. Without that header, the proxy answers ambiguous turns without saving a persistent memory. Both headers accept 1 to 80 ASCII letters, digits, periods, hyphens, or underscores and must start with a letter or digit.
- SQLite uses WAL mode, per-namespace indexes, and a composite foreign key to link superseded facts. A worker thread handles database operations. Retrieval runs an exact cosine similarity search within the namespace using 512-dimensional feature-hashed vectors with n-grams and aliases. Paraphrase matching depends on shared vocabulary.
- The retrieval score is `cosine * exp(-decay_rate * days_since_last_access) * importance_score`. Selected facts update `last_accessed_at`. A fact is archived when its time-weighted importance falls below the threshold, even at maximum cosine similarity. Archived and superseded facts stay in SQLite as history.
- After a response completes, the worker reads the latest user message, retrieves similar facts from the same namespace, and asks the local model for individual facts, supporting evidence, and changed properties. When a value changes, a transaction marks the old fact `superseded` and links it to the replacement. The most recently observed value takes precedence. A local rule can still learn explicit database changes if model extraction fails.
- Memory updates are eventually consistent and use an in-memory queue of up to 32 turns. Chat continues during overload, and new turns can be skipped for learning. An abrupt shutdown can drop queued turns. Run one proxy instance per database.

## Privacy

- The proxy applies patterns for common secrets and identifiers, then runs Ollama's local NER on the pseudonymized text. In `required` mode it returns `503` before forwarding if that check fails or times out. The preflight check contributes to first-token latency. Fact extraction runs in the background.
- Each session and namespace pair uses an in-memory HMAC key with a 30-minute idle timeout. The store holds up to 512 sessions. Without a session header, a stable namespace uses its default session. A response can restore only the values that its request masked. JSON responses and SSE streams restore text and tool arguments, including placeholders split across events.
- SQLite stores cleaned facts with generic markers in place of detected values. The reversible mapping stays in memory. Provider metadata such as `logprobs` retains pseudonyms. If the client supplies `store`, the proxy sets it to `false`. Upstream retention depends on the provider.
- The proxy binds to IPv4 loopback, validates `Host`, and blocks browser-origin requests. It uses separate client and upstream credentials and requires HTTPS for remote upstreams. The NER model and its configuration form part of the trusted boundary. This is a single-user instance, and authorized local clients can select any namespace.
- Pattern matching and NER can miss names, unusual secret formats, or encoded data. Use a local upstream when the entire conversation must remain on your computer. The client receives restored values in chat responses and tool arguments.

## References

- [SQLite in Node.js](https://nodejs.org/api/sqlite.html) and [TypeScript in Node.js](https://nodejs.org/api/typescript.html)
- [Ollama API](https://docs.ollama.com/api/chat) and [local configuration](https://docs.ollama.com/faq)
- [Anthropic OpenAI compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) and [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

## License

Released under the [MIT License](LICENSE).
