FROM python:3.12-slim
WORKDIR /app
COPY server.py .
COPY static/ ./static/
ENV OCR_HOST=0.0.0.0 \
    OCR_PORT=8765 \
    OCR_OLLAMA_URL=http://192.168.1.107:11434
EXPOSE 8765
CMD ["python", "server.py"]
