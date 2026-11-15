# Mnemosyne Proxy

**Local memory and privacy proxy for OpenAI-compatible chat.** It adds project-scoped SQLite memory, retires outdated facts, and reversibly masks detected sensitive text in requests and streamed responses. Ollama handles local entity detection and fact extraction.

Daemon HTTP locale per client OpenAI Chat Completions. Intercetta la chat, recupera i fatti dalla sandbox attiva, pseudonimizza il payload e ripristina i dati nella risposta. SQLite, ricerca vettoriale ed estrazione dei fatti restano sul computer.

## Avvio su Windows

Usa [Node.js 24 LTS](https://nodejs.org/en/download) dalla versione 24.12 in poi e [Ollama](https://ollama.com/download/windows). Apri PowerShell, verifica `node --version` ed esegui questi comandi. Scarica il modello solo se manca dall’elenco di `ollama list`.

```powershell
git clone https://github.com/ermeslogic/mnemosyne-proxy.git
Set-Location .\mnemosyne-proxy
npm.cmd install --offline --no-audit
npm.cmd run db:init
npm.cmd test
ollama pull qwen2.5-coder:1.5b
```

Se PowerShell non trova `ollama`, usa `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"` al suo posto per chiamare l’eseguibile installato da Ollama per Windows.

Per eseguire Ollama in modalità locale, chiudi prima l’eventuale istanza già aperta nell’area di notifica. Avvialo in un terminale dedicato e verifica nel log che il cloud sia disabilitato. Per rendere l’impostazione permanente, imposta `disable_ollama_cloud` a `true` in `~/.ollama/server.json`.

```powershell
$env:OLLAMA_NO_CLOUD = '1'
ollama serve
```

In un altro terminale aperto nella cartella del progetto, avvia Mnemosyne. Il database viene creato anche al primo avvio.

```powershell
npm.cmd start
```

Nel client inserisci `http://127.0.0.1:8787/v1` come base URL e `qwen2.5-coder:1.5b` come modello. Se il client richiede comunque una chiave e `MN_CLIENT_KEY` è vuota, usa un valore fittizio come `local`.

## Verifica con curl

```powershell
curl.exe -fsS http://127.0.0.1:8787/health
curl.exe -fsS http://127.0.0.1:8787/v1/models
$mnBody = '{"model":"qwen2.5-coder:1.5b","stream":true,"max_tokens":80,"messages":[{"role":"user","content":"Rispondi solo con il mio nome. Mi chiamo Mario Rossi."}]}'
$mnBody | curl.exe -sS -N http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' -H 'X-Context-Namespace: demo' -H 'X-Context-Session: prova-1' --data-binary '@-'
```

Lo stream usa `text/event-stream` e termina con `data: [DONE]`. Se il modello ripete il token ricevuto, il client vede `Mario Rossi`. Se hai impostato `MN_CLIENT_KEY`, aggiungi `-H "Authorization: Bearer $env:MN_CLIENT_KEY"` a ogni chiamata.

Per provare la memoria, invia in sequenza `Usiamo MySQL come database.` e `Abbiamo cambiato database da MySQL a PostgreSQL.` con lo stesso namespace. Dopo ogni risposta il worker elabora lo scambio. Chiedi `Quale database usiamo per il progetto?` prima nella sandbox `demo` e poi in `altro-progetto`. Solo `demo` riceve il ricordo di PostgreSQL. `npm.cmd test` verifica anche i due stati nel database, con server HTTP simulati e senza Ollama o credenziali.

## Provider

Imposta `MN_UPSTREAM_BASE_URL` prima di avviare il daemon. Il modello richiesto dal client deve essere disponibile nel provider. Ollama rimane attivo localmente per il controllo privacy e la memoria anche quando il modello principale è remoto.

| Provider | `MN_UPSTREAM_BASE_URL` | Credenziale |
|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | Nessuna per la configurazione predefinita |
| llama.cpp | `http://127.0.0.1:8080/v1` | Chiave di `llama-server` se configurata |
| OpenAI | `https://api.openai.com/v1` | `MN_UPSTREAM_API_KEY` |
| Anthropic | `https://api.anthropic.com/v1` | `MN_UPSTREAM_API_KEY` e `MN_ANTHROPIC_WORKSPACE` se richiesto dalla chiave |

Per Anthropic il daemon usa la compatibilità Chat Completions pubblicata dal provider. Ogni provider gestisce le opzioni abilitate sul modello selezionato. L’interfaccia del daemon copre `POST /v1/chat/completions`, `GET /v1/models` e `GET /health`. I client devono usare Chat Completions e inviare contenuti testuali. `GET /health` verifica lo stato del worker SQLite.

| Variabile | Predefinita | Effetto |
|---|---|---|
| `MN_PORT` | `8787` | Porta su `127.0.0.1` |
| `MN_DB_PATH` | `data/mnemosyne.sqlite` | File SQLite |
| `MN_OLLAMA_URL` | `http://127.0.0.1:11434` | Endpoint Ollama locale |
| `MN_LOCAL_MODEL` | `qwen2.5-coder:1.5b` | Modello locale per NER ed estrazione |
| `MN_CLIENT_KEY` | vuota | Chiave Bearer locale facoltativa, separata dalla chiave del provider |
| `MN_NER_MODE` | `required` | `heuristic` usa le sole regole privacy con upstream su loopback, ad esempio per diagnostica |
| `MN_PRIVACY_TIMEOUT_MS` | `90000` | Budget per il controllo NER, inclusi avvio a freddo ed elaborazione dei lotti |
| `MN_MEMORY_TIMEOUT_MS` | `90000` | Budget per l’estrazione post-risposta |
| `MN_UPSTREAM_TIMEOUT_MS` | `180000` | Budget per la risposta completa del provider o lo stream |
| `MN_DECAY_PER_DAY` | `0.035` | Tasso giornaliero per i nuovi ricordi |
| `MN_RETRIEVAL_BELOW` | `0.55` | Soglia minima per iniettare un ricordo |
| `MN_ARCHIVE_BELOW` | `0.25` | Soglia di archiviazione della forza residua |

## Sandbox e memoria

- `X-Context-Namespace` seleziona un progetto preciso. In assenza dell’header, il dominio prevalente nell’ultimo messaggio sceglie `coding`, `business` o `personal`. I domini automatici sono categorie condivise della stessa istanza. Per progetti dello stesso dominio usa namespace espliciti distinti.
- In caso ambiguo serve `X-Context-Session` per collegare la memoria tra richieste. In sua assenza il turno ambiguo viene elaborato senza apprendere un ricordo persistente. Gli header accettano 1–80 caratteri tra lettere ASCII, numeri, punto, trattino e underscore, con iniziale alfanumerica.
- SQLite usa WAL, indici per namespace e una chiave esterna composta per i collegamenti di supersessione. Un worker thread gestisce tutte le operazioni sul DB. Il retrieval usa coseno SQL su vettori hash a 512 dimensioni con n-grammi e alias, senza download di un modello di embedding. La ricerca è esatta entro la sandbox e l’affinità tra parafrasi dipende dal lessico condiviso.
- Il punteggio è `coseno × exp(-decay_rate × giorni_dall_ultimo_accesso) × importance_score`. Solo i fatti selezionati aggiornano `last_accessed_at`. L’archiviazione avviene quando il fattore temporale moltiplicato per l’importanza scende sotto la soglia, anche con il massimo coseno possibile. I record archiviati e superseduti restano nello storico SQLite.
- Dopo una risposta completata, il worker analizza l’ultimo turno dell’utente, cerca fatti simili nella stessa sandbox e chiede al modello locale fatti atomici, evidenza e proprietà aggiornate. Un nuovo valore rende il precedente `superseded` e lo collega al successore in una transazione. La versione con il timestamp di osservazione più recente ha precedenza. In caso di errore del modello, una regola locale conserva l’apprendimento dei cambi di database espliciti.
- L’apprendimento ha consistenza eventuale e una coda volatile con limite di 32 turni. Durante un sovraccarico la risposta chat continua e l’apprendimento del nuovo turno può essere saltato. A una chiusura improvvisa possono andare persi i turni ancora in coda. Avvia una sola istanza per database.

## Privacy

- Regex per segreti e identificatori comuni, seguite dal riconoscimento di entità Ollama sul testo già pseudonimizzato. In modalità `required`, un errore o timeout del controllo ferma la richiesta con `503` prima del provider. La latenza prima del primo token include il controllo locale. L’estrazione ordinaria avviene in background.
- Ogni coppia sessione/sandbox usa una chiave HMAC volatile, con 30 minuti di inattività e un massimo di 512 sessioni. Se il client omette l’header di sessione, la sandbox stabile usa la sessione predefinita. Ogni richiesta può ripristinare solo i valori che ha appena mascherato. La risposta JSON e lo stream ripristinano il testo e gli argomenti dei tool, anche quando un token è frammentato tra eventi.
- Il DB conserva i fatti ripuliti con marcatori generici, senza la mappa reversibile. I metadati tecnici del provider, come i `logprobs`, mantengono i token pseudonimizzati. Il daemon forza `store: false` quando il client fornisce l’opzione. I criteri di retention del provider dipendono dal servizio configurato.
- Il daemon ascolta su IPv4 loopback, controlla `Host` e blocca origini browser. Le credenziali del client e del provider sono separate. Gli upstream remoti richiedono HTTPS. Il modello NER e la configurazione sono parte del perimetro fidato. L’istanza è per un singolo utente e i client locali autorizzati possono scegliere qualunque namespace.
- Regex e NER possono perdere nomi, segreti in formati insoliti e dati codificati dentro testo. Usa un provider locale per conversazioni che richiedono che tutto il contenuto resti sul computer. L’applicazione client riceve i valori ripristinati, anche negli argomenti dei tool.

## Riferimenti

- [SQLite in Node.js](https://nodejs.org/api/sqlite.html) e [TypeScript in Node.js](https://nodejs.org/api/typescript.html)
- [API Ollama](https://docs.ollama.com/api/chat) e [configurazione locale](https://docs.ollama.com/faq)
- [Compatibilità OpenAI di Anthropic](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) e [server llama.cpp](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

## Licenza

Distribuito con [licenza MIT](LICENSE).
