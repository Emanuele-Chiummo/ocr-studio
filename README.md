# OCR Studio

Webapp per trasformare **PDF scansionati / immagini → Markdown pulito** usando
**GLM-OCR** ospitato in locale su Ollama.

Vista affiancata: a **sinistra** il documento pagina per pagina, a **destra** il
risultato dell'OCR (anteprima renderizzata o markdown grezzo), per confrontare.
Riconosce testo, **tabelle**, **formule** (LaTeX/KaTeX) e blocchi di codice.

```
┌─────────────┬───────────────────────┬──────────────────────────┐
│  miniature  │   PAGINA DEL DOC       │   OCR → MARKDOWN          │
│  ① ② ③ …    │   (PDF/immagine)       │   [Anteprima] [Markdown]  │
└─────────────┴───────────────────────┴──────────────────────────┘
```

## Come funziona

1. Il **frontend** apre il PDF con `pdf.js`, rasterizza ogni pagina in immagine
   (la mostra a sinistra *e* la usa per l'OCR). Le immagini caricate sono già pronte.
2. Invia l'immagine al **backend** (`server.py`, solo libreria standard di Python).
3. Il backend fa da proxy a **Ollama** (`/api/generate` in **streaming**) e rimanda
   il testo token-per-token al browser; rileva i **loop** del modello e **interrompe
   subito** la generazione quando degenera (vedi sotto).
4. Il frontend mostra il markdown **dal vivo** mentre arriva e lo renderizza
   (tabelle, formule, codice) accanto alla pagina.

Nessuna build, niente Node, niente dipendenze pip: serve solo Python 3.

## Requisiti

- **Python 3** (testato su 3.14).
- **Ollama** raggiungibile con il modello `glm-ocr:latest` installato.
- **Connessione internet al primo caricamento** della pagina: le librerie JS
  (`pdf.js`, `marked`, `DOMPurify`, `KaTeX`, `highlight.js`) arrivano da CDN.
  Vedi *Uso offline* per renderle locali.

## Avvio

```bash
cd ocr-studio
python3 server.py
# poi apri http://127.0.0.1:8765
```

Oppure, su Mac, doppio click su **`start.command`** (avvia il server e apre il browser).

All'avvio il server stampa lo stato di Ollama e del modello.

## Uso

1. **Carica PDF o immagini** (anche più file insieme) o trascinali nell'area.
2. **▶ Converti tutto** elabora tutte le pagine in sequenza (oppure **↻ OCR pagina**
   per la sola pagina corrente / per rielaborarla).
3. Naviga con le miniature, i tasti `‹ ›` o le **frecce ← →**. Il pallino sulla
   miniatura indica lo stato: grigio=da fare, giallo=in corso, verde=fatto, rosso=errore.
4. A destra alterna **Anteprima** / **Markdown** grezzo.
5. Esporta: **Copia pagina**, **.md pagina**, **.md completo** (tutte le pagine unite).
6. **⚙ Impostazioni**: prompt, `num_predict`, risoluzione di rendering del PDF.

## Configurazione (variabili d'ambiente)

| Variabile | Default | Descrizione |
|---|---|---|
| `OCR_OLLAMA_URL` | `http://192.168.1.107:11434` | Endpoint Ollama |
| `OCR_MODEL` | `glm-ocr:latest` | Nome del modello |
| `OCR_PROMPT` | `OCR` | Prompt inviato (vuoto = non genera!) |
| `OCR_NUM_PREDICT` | `4096` | Tetto token per pagina (limita i loop) |
| `OCR_KEEP_ALIVE` | `30m` | Quanto Ollama tiene il modello in memoria |
| `OCR_HOST` | `127.0.0.1` | Usa `0.0.0.0` per esporlo in rete |
| `OCR_PORT` | `8765` | Porta del server |
| `OCR_TIMEOUT` | `600` | Timeout (s) per chiamata a Ollama |

Esempio (esposto in LAN, altro Ollama):
```bash
OCR_HOST=0.0.0.0 OCR_OLLAMA_URL=http://10.0.0.5:11434 python3 server.py
```

Prompt e `num_predict` si possono cambiare anche al volo dalle Impostazioni
(override solo per quella sessione del browser).

## Note importanti su GLM-OCR su Ollama

Verificato sul modello reale durante lo sviluppo:

- **Il prompt non può essere vuoto**: con prompt vuoto il modello non genera nulla
  (`done_reason: load`). Il default `OCR` produce markdown pulito. Prompt più
  "verbosi" tendono ad avvolgere l'output in ` ```markdown ` e a peggiorare i loop.
- **I parametri di sampling (es. `repeat_penalty`) vengono ignorati** da questo
  pacchetto (renderer/parser custom): output identico con o senza. `num_predict`
  invece **è rispettato** e fa da tetto di sicurezza.
- **Loop/degenerazione**: su input "sporchi" il modellino (1.1B) può ripetere una
  riga all'infinito. Leggendo in streaming, il backend lo rileva e **interrompe
  subito la generazione** quando una riga si ripete ≥4 volte: salva il contenuto
  buono e risparmia ~20s sulle pagine che degenerano (la pagina mostra `⚠ loop
  interrotto`). Su documenti reali (più puliti dei meta-screenshot) è raro.

### Prestazioni

Il tempo per pagina è dominato dal **prefill dell'immagine** (l'encoder visivo che
"digerisce" la pagina), non dalla generazione del testo:

- ~14s di prefill per un'immagine da ~0,7 MP, ~8s a ~0,35 MP → **cresce con i pixel**.
- La generazione è veloce (~180 token/s) e arriva in **streaming** dal vivo.
- Il modello è in **F16** su RTX 3060 (già su GPU): il prefill è il costo intrinseco.
- **Rielaborare la stessa pagina è quasi istantaneo** (Ollama cache-a il prefill).

Leve nelle **⚙ Impostazioni**:
- **Larghezza max immagine OCR** (default 2000px): ridurla accelera il prefill, ma
  **troppo bassa peggiora la lettura e *aumenta* i loop** (quindi rallenta). Non esagerare.
- **Risoluzione rendering PDF (scala)**: più alta = lettura migliore ma prefill più
  lento. Default 2.0 (≈144 dpi); per scansioni difficili 2.5–3.0.
- Per andare molto più veloce servirebbe una build **quantizzata (Q4)** di GLM-OCR
  al posto della F16.

## Risoluzione problemi

- **Pill "Ollama offline"** → controlla `OCR_OLLAMA_URL`, che Ollama sia attivo e
  raggiungibile: `curl http://192.168.1.107:11434/api/tags`.
- **"modello assente"** → `ollama list` sul server; il nome deve combaciare con `OCR_MODEL`.
- **`⚠ loop interrotto` / `⚠ ripetizioni rimosse`** → il modello è degenerato e la
  generazione è stata fermata; prova a cambiare risoluzione/larghezza max OCR o
  rielabora la pagina con **↻ OCR pagina**.
- **Troppo lento** → vedi *Prestazioni*: è il prefill dell'immagine; riduci la
  larghezza max OCR o la scala, entro limiti (troppo basso = più loop).
- **502 da Ollama** → assicurati di usare `/api/generate` (già impostato).
- **La pagina è "spoglia" / niente anteprima** → manca la connessione alle CDN al
  primo caricamento; vedi *Uso offline*.

## Uso offline (CDN locali)

Se la macchina che serve la UI non ha internet, scarica le librerie in
`static/vendor/` e sostituisci gli `src`/`href` in `static/index.html` con i
percorsi locali (`/vendor/...`). I file servono già da `server.py`.

## Docker

Nessuna dipendenza esterna → immagine minima. Modo più semplice, **docker compose**:

```bash
docker compose up -d --build      # UI su http://localhost:8765
```

Di default il container cerca Ollama **sull'host** (`host.docker.internal:11434`). Perché funzioni:
- l'**Ollama dell'host deve ascoltare su `0.0.0.0`** (non solo `127.0.0.1`), altrimenti il
  container non lo raggiunge → avvialo con `OLLAMA_HOST=0.0.0.0 ollama serve`;
- se Ollama è su un'altra macchina, imposta `OCR_OLLAMA_URL` nel `docker-compose.yml`
  (es. `http://192.168.1.107:11434`).

Senza compose:
```bash
docker build -t ocr-studio .
docker run -d --name ocr-studio -p 8765:8765 \
  -e OCR_HOST=0.0.0.0 \
  -e OCR_OLLAMA_URL=http://host.docker.internal:11434 \
  --add-host host.docker.internal:host-gateway \
  ocr-studio
```

Su **TrueNAS SCALE** puoi usarlo come *Custom App* (immagine `ocr-studio`, porta 8765,
stesse env), puntando `OCR_OLLAMA_URL` all'indirizzo interno di Ollama.

## Privacy e dati

**Nessun documento viene salvato su disco.** Il flusso è interamente in memoria:
- il PDF/immagine viene aperto e rasterizzato **nel browser** (il file non viene mai caricato come tale);
- ogni pagina-immagine va al backend solo come dato della richiesta, viene inoltrata a
  Ollama e **non viene scritta da nessuna parte** — né l'immagine né il markdown;
- a fine richiesta tutto è scartato; chiudendo o ricaricando la pagina la sessione sparisce;
- l'unica cosa che persiste è nelle ⚙ Impostazioni del browser (prompt, scala, …) in
  `localStorage`: **preferenze, non contenuti**;
- i file `.md` vengono creati **solo** quando premi tu "Scarica", nella tua cartella Download.

(Ollama tiene in RAM/VRAM una cache del prefill per la durata di `keep_alive` — per questo
rielaborare la stessa pagina è istantaneo — ma non scrive le immagini su disco.)

## Sicurezza ed esposizione in rete

Punto chiave: **il browser non parla mai direttamente con Ollama.** Il browser chiama solo
il backend di OCR Studio; è il **backend** (server-to-server) a parlare con Ollama. Quindi
Ollama deve essere raggiungibile **solo dal backend**, mai dal browser/internet.

- **Hosti tu e condividi il link dell'app** → ✅ nessun problema lato Ollama. Esponi solo
  OCR Studio (porta 8765); il backend raggiunge Ollama sulla tua LAN (`192.168.1.107`), che
  **resta privato**. Ollama NON va messo su internet.
- **Un amico installa il Docker da sé** → dipende da *quale* Ollama usa:
  - il **suo** Ollama locale (consigliato) → imposta `OCR_OLLAMA_URL` sul suo Ollama: niente
    da esporre, tutto resta da lui;
  - **il tuo** Ollama/GPU → allora sì, il tuo Ollama dovrebbe essergli raggiungibile. **Non
    esporre Ollama "nudo" su internet**: non ha autenticazione, chiunque potrebbe usarlo,
    scaricare modelli, saturare la GPU. Usa una **VPN** (Tailscale) o un **tunnel**
    (Cloudflare Tunnel) tra voi due.

⚠️ **L'app non ha autenticazione.** Se la esponi su internet, chiunque abbia il link può
usare la tua GPU e caricare documenti. Per condividere in sicurezza:
- **Tailscale / WireGuard** (più semplice): l'app resta in rete privata, l'amico entra nella
  tua tailnet e apre `http://<tuo-host>:8765`. Niente esposto pubblicamente.
- **Cloudflare Tunnel** con Access davanti, se vuoi un link pubblico ma protetto.
- **reverse proxy** (Caddy/nginx) con Basic Auth + HTTPS.

In sintesi: **condividere l'app via VPN/tunnel ≫ esporre Ollama**. Ollama tienilo sempre
dietro la tua rete.

## Struttura

```
ocr-studio/
├── server.py            # backend stdlib: statici + /api/ocr (streaming) + /api/health + anti-loop
├── static/
│   ├── index.html       # UI (CDN: pdf.js, marked, DOMPurify, KaTeX, highlight.js)
│   ├── styles.css        # tema scuro, vista divisa, miniature, barra di progresso
│   └── app.js           # logica: rasterizzazione, OCR streaming per-pagina, rendering, export
├── Dockerfile           # immagine minima (solo Python, niente pip)
├── start.command        # avvio + apertura browser (Mac)
├── smoke_test.py        # diagnostica: varianti di prompt su un'immagine
├── stream_test.py       # diagnostica: streaming + tempi prefill/generazione
└── README.md
```

## Diagnostica del modello

```bash
python3 smoke_test.py /percorso/immagine.png     # prova varianti di prompt
python3 stream_test.py /percorso/immagine.png    # misura prefill vs generazione, tok/s
```
Utili per capire come reagisce GLM-OCR a un certo tipo di documento e dove va il tempo.
