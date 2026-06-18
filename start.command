#!/bin/bash
# Doppio click per avviare OCR Studio e aprire il browser.
cd "$(dirname "$0")" || exit 1
( sleep 1.5; open "http://127.0.0.1:8765" ) &
exec python3 server.py
