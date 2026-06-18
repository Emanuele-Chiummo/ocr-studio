#!/usr/bin/env python3
"""Smoke test GLM-OCR su Ollama: prova varianti di prompt su un'immagine e stampa l'output.
Solo stdlib, nessuna dipendenza. Uso: python3 smoke_test.py <immagine>"""
import base64, json, sys, time, urllib.request

OLLAMA = "http://192.168.1.107:11434"
MODEL = "glm-ocr:latest"

PROMPTS = {
    "empty": "",
    "ocr": "OCR",
    "explicit": ("Convert the document in the image to clean Markdown. "
                 "Preserve tables as Markdown tables, render formulas as LaTeX, "
                 "and describe figures."),
}

def call(image_b64, prompt):
    payload = {"model": MODEL, "prompt": prompt, "images": [image_b64],
               "stream": False, "options": {"temperature": 0}}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(OLLAMA + "/api/generate", data=data,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        body = json.loads(r.read())
    return body, time.time() - t0

def main():
    img_path = sys.argv[1]
    with open(img_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    print(f"Immagine: {img_path}  (~{len(b64)//1024} KB base64)\n")
    for name, prompt in PROMPTS.items():
        print(f"{'='*70}\nPROMPT [{name}]: {prompt!r}")
        try:
            body, dt = call(b64, prompt)
            resp = body.get("response", "")
            print(f"  tempo: {dt:.1f}s  |  lunghezza output: {len(resp)} char")
            print(f"  done_reason: {body.get('done_reason')}  "
                  f"eval_count: {body.get('eval_count')}")
            print("-" * 70)
            print(resp[:2000])
            if len(resp) > 2000:
                print(f"... [+{len(resp)-2000} char]")
        except Exception as e:
            print(f"  ERRORE: {type(e).__name__}: {e}")
        print()

if __name__ == "__main__":
    main()
