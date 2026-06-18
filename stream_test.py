#!/usr/bin/env python3
"""Diagnostica streaming + dove va il tempo. Uso: python3 stream_test.py <img>"""
import base64, json, sys, time, urllib.request

OLLAMA = "http://192.168.1.107:11434"
MODEL = "glm-ocr:latest"

def ns(x): return (x or 0) / 1e9  # nanosec -> sec

def run(path, num_predict=4096):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    payload = {"model": MODEL, "prompt": "OCR", "images": [b64], "stream": True,
               "keep_alive": "30m", "options": {"temperature": 0, "num_predict": num_predict}}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(OLLAMA + "/api/generate", data=data,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time(); ttft = None; chunks = 0; buf = []; final = {}
    with urllib.request.urlopen(req, timeout=600) as r:
        for raw in r:                         # iterazione = chunk NDJSON appena arriva
            raw = raw.strip()
            if not raw:
                continue
            obj = json.loads(raw)
            tok = obj.get("response", "")
            if tok and ttft is None:
                ttft = time.time() - t0
            if tok:
                buf.append(tok); chunks += 1
            if obj.get("done"):
                final = obj
    total = time.time() - t0
    text = "".join(buf)
    print(f"  file={path.split('/')[-1]!r}  num_predict={num_predict}")
    print(f"  streaming chunks ricevuti: {chunks}  (se >1 lo streaming token-by-token FUNZIONA)")
    print(f"  TTFT (primo token): {ttft:.1f}s   TOTALE: {total:.1f}s")
    print(f"  load(modello): {ns(final.get('load_duration')):.1f}s | "
          f"prefill immagine: {ns(final.get('prompt_eval_duration')):.1f}s "
          f"({final.get('prompt_eval_count')} tok) | "
          f"generazione: {ns(final.get('eval_duration')):.1f}s "
          f"({final.get('eval_count')} tok)")
    ec, ed = final.get("eval_count"), ns(final.get("eval_duration"))
    if ec and ed:
        print(f"  velocità generazione: {ec/ed:.0f} tok/s")
    print(f"  done_reason={final.get('done_reason')}  output={len(text)} char")
    print()

if __name__ == "__main__":
    run(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 4096)
