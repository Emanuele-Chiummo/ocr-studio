#!/usr/bin/env python3
"""
OCR Studio - backend stdlib (nessuna dipendenza esterna).

Serve il frontend statico e fa da proxy verso Ollama/GLM-OCR, con pulizia
anti-loop dell'output. Avvio:  python3 server.py
Config via variabili d'ambiente (vedi sotto) oppure override per-richiesta.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ----------------------------------------------------------------------------
# Configurazione (override con variabili d'ambiente)
# ----------------------------------------------------------------------------
OLLAMA_URL   = os.environ.get("OCR_OLLAMA_URL", "http://192.168.1.107:11434").rstrip("/")
MODEL        = os.environ.get("OCR_MODEL", "glm-ocr:latest")
PROMPT       = os.environ.get("OCR_PROMPT", "OCR")
NUM_PREDICT  = int(os.environ.get("OCR_NUM_PREDICT", "4096"))
KEEP_ALIVE   = os.environ.get("OCR_KEEP_ALIVE", "30m")
HOST         = os.environ.get("OCR_HOST", "127.0.0.1")
PORT         = int(os.environ.get("OCR_PORT", "8765"))
TIMEOUT      = int(os.environ.get("OCR_TIMEOUT", "600"))

STATIC_DIR = Path(__file__).parent / "static"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif":  "image/gif",
}


# ----------------------------------------------------------------------------
# Pulizia anti-loop dell'output del modello
# ----------------------------------------------------------------------------
def clean_markdown(text: str):
    """Rimuove i pattern di degenerazione tipici di GLM-OCR su Ollama.

    Ritorna (testo_pulito, truncated_bool).
    - toglie un eventuale wrapper globale ```markdown ... ```
    - tronca quando una riga identica si ripete >= RUN_LIMIT volte di fila
      (segnale inequivocabile di loop: tutto ciò che segue è spazzatura)
    - collassa run di righe vuote multiple
    """
    if not text:
        return "", False

    text = text.strip()

    # 1) wrapper globale ```markdown ... ``` o ``` ... ```
    fence = re.match(r"^```[a-zA-Z]*\s*\n(.*?)\n?```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()

    lines = text.split("\n")
    out = []
    truncated = False
    RUN_LIMIT = 4          # quante ripetizioni consecutive prima di considerarlo loop
    prev = None
    run = 0
    blank_run = 0

    for line in lines:
        stripped = line.strip()

        # collassa righe vuote multiple (max 1 vuota consecutiva)
        if stripped == "":
            blank_run += 1
            if blank_run > 1:
                continue
            out.append("")
            prev = None
            run = 0
            continue
        blank_run = 0

        # rilevamento loop: stessa riga (trimmata) ripetuta
        if stripped == prev:
            run += 1
            if run >= RUN_LIMIT:
                # loop conclamato: butto via questa e tutto il resto
                # e rimuovo anche le RUN_LIMIT-1 copie già aggiunte
                del out[-(RUN_LIMIT - 1):]
                truncated = True
                break
        else:
            run = 1
            prev = stripped
        out.append(line)

    cleaned = "\n".join(out).strip()
    return cleaned, truncated


# ----------------------------------------------------------------------------
# Chiamata a Ollama
# ----------------------------------------------------------------------------
class LoopGuard:
    """Rileva in streaming quando una riga (trimmata) si ripete troppe volte
    di fila: segnale di degenerazione del modello. feed() ritorna True al loop."""
    LIMIT = 4  # numero di occorrenze identiche consecutive che fa scattare lo stop

    def __init__(self):
        self.buf = ""
        self.prev = None
        self.run = 1

    def feed(self, text: str) -> bool:
        self.buf += text
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            t = line.strip()
            if t == "":
                self.prev = None
                self.run = 1
                continue
            if t == self.prev:
                self.run += 1
                if self.run >= self.LIMIT:
                    return True
            else:
                self.prev = t
                self.run = 1
        return False


def ollama_health():
    """Verifica raggiungibilità Ollama e presenza del modello."""
    try:
        with urllib.request.urlopen(OLLAMA_URL + "/api/tags", timeout=8) as r:
            tags = json.loads(r.read())
        names = [m.get("name", "") for m in tags.get("models", [])]
        return {
            "ok": True,
            "ollama_url": OLLAMA_URL,
            "model": MODEL,
            "model_present": MODEL in names,
            "models": names,
        }
    except Exception as e:
        return {"ok": False, "ollama_url": OLLAMA_URL, "error": f"{type(e).__name__}: {e}"}


# ----------------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------------
def strip_data_url(s: str) -> str:
    """Accetta sia 'data:image/png;base64,XXXX' sia il base64 puro."""
    if "," in s and s.strip().lower().startswith("data:"):
        return s.split(",", 1)[1]
    return s


class Handler(BaseHTTPRequestHandler):
    server_version = "OCRStudio/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    # ---- utility risposte ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data: bytes, content_type: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- GET: statici + health ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            return self._send_json(ollama_health())
        if path == "/api/config":
            return self._send_json({
                "model": MODEL, "prompt": PROMPT,
                "num_predict": NUM_PREDICT, "ollama_url": OLLAMA_URL,
            })

        if path == "/":
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        # niente path traversal fuori da static/
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            return self._send_json({"error": "not found"}, 404)
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        return self._send_bytes(target.read_bytes(), ctype)

    # ---- POST: OCR ----
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/ocr":
            return self._send_json({"error": "not found"}, 404)

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
        except Exception as e:
            return self._send_json({"error": f"bad request: {e}"}, 400)

        image = body.get("image")
        if not image:
            return self._send_json({"error": "campo 'image' mancante"}, 400)
        image = strip_data_url(image)
        prompt = (body.get("prompt") or PROMPT).strip() or PROMPT
        num_predict = int(body.get("num_predict") or NUM_PREDICT)

        # Risposta in streaming SSE (text/event-stream) con transfer chunked: è il
        # formato che i proxy (es. Cloudflare) inoltrano SENZA bufferizzare, così il
        # testo arriva dal vivo anche dietro tunnel. Ogni evento: "data: {json}\n\n".
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")     # niente buffering lato proxy
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        def emit(obj):                                  # un evento SSE come chunk HTTP
            data = ("data: " + json.dumps(obj) + "\n\n").encode("utf-8")
            self.wfile.write(("%X\r\n" % len(data)).encode() + data + b"\r\n")
            self.wfile.flush()

        emit({"type": "start"})   # apre subito lo stream (evita buffering/timeout iniziali)

        payload = {
            "model": MODEL, "prompt": prompt, "images": [image], "stream": True,
            "keep_alive": KEEP_ALIVE,
            "options": {"temperature": 0, "num_predict": num_predict},
        }
        req = urllib.request.Request(
            OLLAMA_URL + "/api/generate", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})

        full, guard, stopped_early, final = [], LoopGuard(), False, {}
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                for line in r:                       # ogni riga = un chunk NDJSON di Ollama
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    tok = obj.get("response", "")
                    if tok:
                        full.append(tok)
                        emit({"type": "delta", "text": tok})
                        if guard.feed(tok):          # loop -> esco e chiudo (Ollama annulla)
                            stopped_early = True
                            break
                    if obj.get("done"):
                        final = obj
                        break
            raw_text = "".join(full)
            cleaned, truncated = clean_markdown(raw_text)
            emit({
                "type": "done",
                "markdown": cleaned,
                "truncated": truncated or stopped_early,
                "stopped_early": stopped_early,
                "raw_length": len(raw_text),
                "done_reason": final.get("done_reason"),
                "eval_count": final.get("eval_count"),
                "duration_ms": (final.get("total_duration") or 0) // 1_000_000,
            })
        except urllib.error.URLError as e:
            try:
                emit({"type": "error", "error": f"Ollama non raggiungibile su {OLLAMA_URL}: {e}"})
            except Exception:
                pass
        except (BrokenPipeError, ConnectionResetError):
            return                                   # il client ha chiuso: stop
        except Exception as e:
            try:
                emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass
        finally:
            try:
                self.wfile.write(b"0\r\n\r\n")        # chiude lo stream chunked
                self.wfile.flush()
            except Exception:
                pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    print(f"OCR Studio")
    print(f"  Ollama : {OLLAMA_URL}  (modello: {MODEL}, prompt: {PROMPT!r}, num_predict: {NUM_PREDICT})")
    h = ollama_health()
    if h["ok"]:
        present = "OK" if h.get("model_present") else "ATTENZIONE: non trovato!"
        print(f"  Stato  : Ollama raggiungibile, modello {present}")
    else:
        print(f"  Stato  : Ollama NON raggiungibile -> {h.get('error')}")
    print(f"  UI     : http://{HOST}:{PORT}\n")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nArresto.")
        srv.shutdown()


if __name__ == "__main__":
    main()
