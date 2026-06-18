/* OCR Studio — frontend */
"use strict";

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
if (window.marked) marked.setOptions({ gfm: true, breaks: false });

const $ = (id) => document.getElementById(id);

const DEFAULTS = { prompt: "OCR", numPredict: 4096, scale: 2.0, ocrMaxWidth: 2000 };

const state = {
  pages: [],          // {kind,name,dataUrl,ocrDataUrl,thumb,status,markdown,live,error,meta}
  current: -1,
  scale: DEFAULTS.scale,
  prompt: DEFAULTS.prompt,
  numPredict: DEFAULTS.numPredict,
  ocrMaxWidth: DEFAULTS.ocrMaxWidth,
  zoom: 1,
  running: false,
  abort: false,
};

// ---------------------------------------------------------------- settings
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("ocrstudio") || "{}");
    if (s.prompt != null) state.prompt = s.prompt;
    if (s.numPredict) state.numPredict = s.numPredict;
    if (s.scale) state.scale = s.scale;
    if (s.ocrMaxWidth) state.ocrMaxWidth = s.ocrMaxWidth;
  } catch (e) {}
}
function saveSettings() {
  localStorage.setItem("ocrstudio", JSON.stringify({
    prompt: state.prompt, numPredict: state.numPredict,
    scale: state.scale, ocrMaxWidth: state.ocrMaxWidth,
  }));
}

// ---------------------------------------------------------------- health
async function checkHealth() {
  const pill = $("health");
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    if (j.ok && j.model_present) {
      pill.className = "pill pill-ok";
      pill.textContent = "● Ollama · " + j.model;
      pill.title = j.ollama_url;
    } else if (j.ok) {
      pill.className = "pill pill-err";
      pill.textContent = "● modello assente";
      pill.title = "Modello " + j.model + " non trovato su " + j.ollama_url;
    } else {
      pill.className = "pill pill-err";
      pill.textContent = "● Ollama offline";
      pill.title = j.error || "non raggiungibile";
    }
  } catch (e) {
    pill.className = "pill pill-err";
    pill.textContent = "● backend offline";
  }
}

// ---------------------------------------------------------------- toast
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ---------------------------------------------------------------- file load
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}
function makeThumb(srcCanvas) {
  const w = 116;
  const h = Math.max(1, Math.round(srcCanvas.height * (w / srcCanvas.width)));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(srcCanvas, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.6);
}

// Immagine da mandare all'OCR: ridotta se supera il tetto (prefill più veloce).
// Se è già entro il limite riusa il dataURL pieno (niente copia in memoria).
function makeOcrDataUrl(srcCanvas, fullDataUrl) {
  const cap = state.ocrMaxWidth || 2000;
  const long = Math.max(srcCanvas.width, srcCanvas.height);
  if (long <= cap) return fullDataUrl;
  const k = cap / long;
  const c = document.createElement("canvas");
  c.width = Math.round(srcCanvas.width * k);
  c.height = Math.round(srcCanvas.height * k);
  c.getContext("2d").drawImage(srcCanvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  // nuova selezione = nuovo documento
  state.pages = [];
  state.current = -1;
  $("progressbar").classList.add("hidden");
  $("progress").textContent = "";
  $("fileName").textContent = files.length === 1 ? files[0].name : files.length + " file";

  for (const f of files) {
    try {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        await loadPdf(f);
      } else if (f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f.name)) {
        await loadImage(f);
      } else {
        toast("Tipo non supportato: " + f.name, "err");
      }
    } catch (e) {
      console.error(e);
      toast("Errore caricando " + f.name + ": " + e.message, "err");
    }
  }
  if (state.pages.length) {
    state.current = 0;
    showPage();
    enableDocButtons(true);
  }
  refreshExportButtons();
}

async function loadPdf(file) {
  if (!window.pdfjsLib) { toast("pdf.js non caricato (serve connessione per la CDN)", "err"); return; }
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: state.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    state.pages.push({
      kind: "pdf", name: file.name + " · p" + i,
      dataUrl, ocrDataUrl: makeOcrDataUrl(canvas, dataUrl), thumb: makeThumb(canvas),
      status: "idle", markdown: "", live: "", error: "", meta: null,
    });
    if (state.current === -1) { state.current = 0; showPage(); enableDocButtons(true); }
    renderFilmstrip();
    $("fileName").textContent = file.name + " — " + pdf.numPages + " pagine";
    await new Promise(r => setTimeout(r, 0)); // lascia respirare la UI
  }
}

async function loadImage(file) {
  const dataUrl = await readAsDataURL(file);
  const img = await loadImg(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  state.pages.push({
    kind: "img", name: file.name, dataUrl,
    ocrDataUrl: makeOcrDataUrl(canvas, dataUrl), thumb: makeThumb(canvas),
    status: "idle", markdown: "", live: "", error: "", meta: null,
  });
  if (state.current === -1) { state.current = 0; showPage(); enableDocButtons(true); }
  renderFilmstrip();
}

// ---------------------------------------------------------------- rendering
function renderFilmstrip() {
  const fs = $("filmstrip");
  fs.innerHTML = "";
  state.pages.forEach((p, idx) => {
    const d = document.createElement("div");
    d.className = "thumb" + (idx === state.current ? " active" : "");
    d.innerHTML =
      '<img src="' + p.thumb + '" alt="">' +
      '<span class="tnum">' + (idx + 1) + "</span>" +
      '<span class="tdot ' + p.status + '"></span>';
    d.onclick = () => { state.current = idx; showPage(); };
    fs.appendChild(d);
  });
}

function showPage() {
  const p = state.pages[state.current];
  const docView = $("docView");
  if (!p) {
    docView.innerHTML =
      '<div class="dropzone" id="dropzone"><div class="dz-inner">' +
      '<div class="dz-icon">⇪</div><div class="dz-title">Trascina qui un PDF o delle immagini</div>' +
      '<div class="dz-sub">oppure usa “Carica PDF o immagini”.</div></div></div>';
    wireDropzone();
    $("pageLabel").textContent = "— / —";
    renderResult(null);
    return;
  }
  docView.innerHTML = '<img class="page" src="' + p.dataUrl + '" alt="' + p.name + '">';
  $("pageLabel").textContent = (state.current + 1) + " / " + state.pages.length;
  renderResult(p);
  renderFilmstrip();
}

function renderResult(p) {
  const preview = $("preview");
  const raw = $("raw");
  const meta = $("pageMeta");
  if (!p) { preview.innerHTML = ""; raw.value = ""; meta.innerHTML = ""; return; }

  if (p.status === "processing") {            // mostra il testo che arriva dal vivo
    renderMarkdown(p.live || "");
    raw.value = p.live || "";
    meta.innerHTML = '<span class="warn">● avvio…</span>';   // aggiornato dal timer
    return;
  }

  raw.value = p.markdown || "";
  renderMarkdown(p.markdown || "");

  if (p.status === "error")
    meta.innerHTML = '<span class="warn">errore: ' + escapeHtml(p.error || "") + "</span>";
  else if (p.status === "done") {
    let s = "";
    const dur = (p.meta && p.meta.duration_ms) ? p.meta.duration_ms / 1000
              : (p._t1 && p._t0 ? (p._t1 - p._t0) / 1000 : 0);
    if (dur) s += dur.toFixed(1) + "s";
    if (p.meta && p.meta.eval_count) s += (s ? " · " : "") + p.meta.eval_count + " tok";
    if (p.meta && p.meta.stopped_early) s += ' · <span class="warn">⚠ loop interrotto</span>';
    else if (p.meta && p.meta.truncated) s += ' · <span class="warn">⚠ ripetizioni rimosse</span>';
    meta.innerHTML = s || "fatto";
  } else meta.innerHTML = '<span class="muted">non ancora elaborata</span>';
}

function renderMarkdown(md) {
  const preview = $("preview");
  if (!md) { preview.innerHTML = ""; return; }
  let html;
  try { html = window.marked ? marked.parse(md) : escapeHtml(md); }
  catch (e) { html = escapeHtml(md); }
  if (window.DOMPurify) html = DOMPurify.sanitize(html);
  preview.innerHTML = html;
  if (window.renderMathInElement) {
    try {
      renderMathInElement(preview, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ], throwOnError: false,
      });
    } catch (e) {}
  }
  if (window.hljs) {
    preview.querySelectorAll("pre code").forEach((b) => {
      try { hljs.highlightElement(b); } catch (e) {}
    });
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- OCR
async function ocrPage(idx) {
  const p = state.pages[idx];
  if (!p) return;
  p.status = "processing"; p.error = ""; p.live = ""; p.markdown = ""; p.meta = null;
  p._t0 = performance.now(); p._t1 = 0;
  if (idx === state.current) renderResult(p);
  renderFilmstrip();
  try {
    const r = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: p.ocrDataUrl || p.dataUrl,
        prompt: state.prompt, num_predict: state.numPredict,
      }),
    });
    if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", lastRender = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {           // una riga NDJSON per volta
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "delta") {
          p.live += msg.text;
          if (idx === state.current) {
            const now = performance.now();
            if (now - lastRender > 120) { lastRender = now; renderLive(p); } // throttle
          }
        } else if (msg.type === "done") {
          p.status = "done"; p.markdown = msg.markdown || ""; p.meta = msg; p.live = "";
        } else if (msg.type === "error") {
          p.status = "error"; p.error = msg.error || "errore";
        }
      }
    }
    if (p.status === "processing") {                    // stream finito senza "done"
      if (p.live) { p.status = "done"; p.markdown = p.live; p.live = ""; }
      else { p.status = "error"; p.error = "stream interrotto"; }
    }
  } catch (e) {
    p.status = "error"; p.error = e.message;
  }
  p._t1 = performance.now();
  if (idx === state.current) renderResult(p);
  renderFilmstrip();
  refreshExportButtons();
}

function renderLive(p) {
  renderMarkdown(p.live || "");
  $("raw").value = p.live || "";
}

function setProgress(done, total, active) {
  const bar = $("progressbar"), fill = $("progressFill");
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.classList.remove("hidden");
  bar.classList.toggle("active", !!active);
  fill.style.width = pct + "%";
  return pct;
}

async function runAll() {
  if (state.running) return;
  const todo = state.pages.map((p, i) => i).filter((i) =>
    state.pages[i].status === "idle" || state.pages[i].status === "error");
  if (!todo.length) { toast("Tutte le pagine sono già elaborate.", ""); return; }

  state.running = true; state.abort = false;
  $("btnRunAll").disabled = true; $("btnStop").disabled = false;
  let done = 0;
  setProgress(0, todo.length, true);
  for (const i of todo) {
    if (state.abort) break;
    const pct = setProgress(done, todo.length, true);
    $("progress").textContent = "Elaboro " + (done + 1) + "/" + todo.length + " · " + pct + "%";
    await ocrPage(i);
    done++;
  }
  state.running = false;
  $("btnRunAll").disabled = false; $("btnStop").disabled = true;
  setProgress(done, todo.length, false);
  $("progress").textContent = state.abort
    ? "Interrotto a " + done + "/" + todo.length + "."
    : "Completato: " + done + " pagine.";
  // nascondi la barra dopo un attimo se non riparte un nuovo batch
  setTimeout(() => { if (!state.running) $("progressbar").classList.add("hidden"); }, 1500);
}

// ---------------------------------------------------------------- export
function refreshExportButtons() {
  const anyDone = state.pages.some((p) => p.status === "done" && p.markdown);
  const cur = state.pages[state.current];
  $("btnCopy").disabled = !(cur && cur.markdown);
  $("btnDownloadPage").disabled = !(cur && cur.markdown);
  $("btnDownloadAll").disabled = !anyDone;
}
function download(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function buildAllMarkdown() {
  return state.pages.map((p, i) =>
    "<!-- Pagina " + (i + 1) + " — " + p.name + " -->\n\n" + (p.markdown || "_(vuota)_")
  ).join("\n\n---\n\n");
}

// ---------------------------------------------------------------- UI wiring
function enableDocButtons(on) {
  $("btnRunAll").disabled = !on;
  $("btnRunPage").disabled = !on;
}
function setZoom(z) {
  state.zoom = Math.min(3, Math.max(0.5, z));
  document.documentElement.style.setProperty("--zoom", state.zoom);
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
}

function wireDropzone() {
  const dz = document.querySelector(".dropzone");
  if (!dz) return;
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });
}

function openSettings() {
  $("setPrompt").value = state.prompt;
  $("setNumPredict").value = state.numPredict;
  $("setScale").value = state.scale;
  $("setOcrMaxWidth").value = state.ocrMaxWidth;
  $("scaleLabel").textContent = (+state.scale).toFixed(2);
  $("settingsOverlay").classList.remove("hidden");
}

function initSettingsModal() {
  $("btnSettings").onclick = openSettings;
  $("closeSettings").onclick = () => $("settingsOverlay").classList.add("hidden");
  $("settingsOverlay").addEventListener("click", (e) => {
    if (e.target === $("settingsOverlay")) $("settingsOverlay").classList.add("hidden");
  });
  $("setScale").addEventListener("input", (e) =>
    $("scaleLabel").textContent = (+e.target.value).toFixed(2));
  $("saveSettings").onclick = () => {
    const oldScale = state.scale;
    state.prompt = $("setPrompt").value || DEFAULTS.prompt;
    state.numPredict = parseInt($("setNumPredict").value) || DEFAULTS.numPredict;
    state.scale = parseFloat($("setScale").value) || DEFAULTS.scale;
    state.ocrMaxWidth = parseInt($("setOcrMaxWidth").value) || DEFAULTS.ocrMaxWidth;
    saveSettings();
    $("settingsOverlay").classList.add("hidden");
    if (state.scale !== oldScale && state.pages.some((p) => p.kind === "pdf"))
      toast("La nuova risoluzione si applica ricaricando il PDF.", "");
    else toast("Impostazioni salvate.", "ok");
  };
}

function initDivider() {
  const divider = $("divider");
  const split = $("split");
  let dragging = false;
  divider.addEventListener("mousedown", () => { dragging = true; document.body.style.cursor = "col-resize"; });
  window.addEventListener("mouseup", () => { dragging = false; document.body.style.cursor = ""; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const left = e.clientX - rect.left - 132; // larghezza filmstrip
    const w = Math.min(rect.width - 132 - 280, Math.max(260, left));
    document.documentElement.style.setProperty("--split", w + "px");
  });
}

function init() {
  loadSettings();
  setZoom(1);
  $("endpointInfo") && fetch("/api/config").then(r => r.json()).then(c => {
    $("endpointInfo").textContent = c.ollama_url + "  ·  " + c.model;
  }).catch(() => {});

  $("fileInput").addEventListener("change", (e) => handleFiles(e.target.files));
  wireDropzone();

  $("btnRunAll").onclick = runAll;
  $("btnStop").onclick = () => { state.abort = true; };
  $("btnRunPage").onclick = () => { if (state.current >= 0) ocrPage(state.current); };

  $("prevPage").onclick = () => { if (state.current > 0) { state.current--; showPage(); } };
  $("nextPage").onclick = () => { if (state.current < state.pages.length - 1) { state.current++; showPage(); } };
  $("zoomIn").onclick = () => setZoom(state.zoom + 0.25);
  $("zoomOut").onclick = () => setZoom(state.zoom - 0.25);

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const raw = t.dataset.tab === "raw";
      $("raw").hidden = !raw;
      $("preview").hidden = raw;
    };
  });

  $("btnCopy").onclick = () => {
    const cur = state.pages[state.current];
    if (cur?.markdown) navigator.clipboard.writeText(cur.markdown).then(() => toast("Copiato.", "ok"));
  };
  $("btnDownloadPage").onclick = () => {
    const cur = state.pages[state.current];
    if (cur?.markdown) download("pagina-" + String(state.current + 1).padStart(2, "0") + ".md", cur.markdown);
  };
  $("btnDownloadAll").onclick = () => download("documento.md", buildAllMarkdown());

  // scorciatoie tastiera
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    if (e.key === "ArrowLeft") $("prevPage").click();
    else if (e.key === "ArrowRight") $("nextPage").click();
  });

  initSettingsModal();
  initDivider();
  checkHealth();
  setInterval(checkHealth, 20000);

  // indicatore di attività della pagina corrente mentre l'OCR è in corso
  setInterval(() => {
    const p = state.pages[state.current];
    if (p && p.status === "processing") {
      const sec = Math.round((performance.now() - (p._t0 || performance.now())) / 1000);
      const phase = (p.live && p.live.length)
        ? "scrittura… " + p.live.length + " char"
        : "analisi immagine…";
      $("pageMeta").innerHTML = '<span class="warn">● ' + phase + " · " + sec + "s</span>";
    }
  }, 300);
}

document.addEventListener("DOMContentLoaded", init);
