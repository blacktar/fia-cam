(() => {
  'use strict';

  const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';

  const MAP = {
    width: 16100,
    height: 16100,
    // Exact printed coordinate-line bounds in the supplied 16100 px map.
    // The numbered grid is inset from the image border and uses 112 px cells.
    left: 432,
    right: 15664,
    top: 1103,
    bottom: 15663,
    minE: 0,
    maxE: 135,
    minN: 0,
    maxN: 129
  };
  MAP.cellX = (MAP.right - MAP.left) / 136;
  MAP.cellY = (MAP.bottom - MAP.top) / 130;

  const COLORS = ['#e95f4f', '#f0a43c', '#2c9f83', '#467dcc', '#a963d6'];
  const TILE_SIZE = 1024;
  const LEVELS = [1007, 2013, 4025, 8050, 16100].map((size, level) => ({ level, size, ratio: size / MAP.width }));
  const MAX_CACHED_TILES = 48;
  const canvas = document.querySelector('#map-canvas');
  const ctx = canvas.getContext('2d');
  const viewport = document.querySelector('#map-viewport');
  const rowsHost = document.querySelector('#coordinate-rows');
  const legend = document.querySelector('#legend');
  const count = document.querySelector('#location-count');
  const shareButton = document.querySelector('#share-locations');
  const shareStatus = document.querySelector('#share-status');
  const mapTabs = document.querySelector('.map-tabs');
  const mapTabMessage = document.querySelector('#map-tab-message');
  const readout = document.querySelector('#cursor-readout');
  const loading = document.querySelector('#loading');
  const tileCache = new Map();
  const state = { scale: 1, minScale: 1, maxScale: 1, x: 0, y: 0, viewportWidth: 0, viewportHeight: 0, dragging: false, lastX: 0, lastY: 0, pointerStartX: 0, pointerStartY: 0, pointerMoved: false, points: [], pointers: new Map(), pinchDistance: 0, mapReady: false };

  for (let i = 0; i < 5; i += 1) {
    rowsHost.insertAdjacentHTML('beforeend', `
      <div class="coordinate-row" data-row="${i}">
        <span class="row-number">${i + 1}.</span>
        <input name="easting-${i}" inputmode="numeric" maxlength="3" autocomplete="off" placeholder="065" aria-label="Location ${i + 1} Easting">
        <input name="northing-${i}" inputmode="numeric" maxlength="3" autocomplete="off" placeholder="031" aria-label="Location ${i + 1} Northing">
      </div>`);
  }

  const rowEls = [...document.querySelectorAll('.coordinate-row')];
  const inputs = rowEls.flatMap((row) => [...row.querySelectorAll('input')]);
  const scannerDialog = document.querySelector('#scanner-dialog');
  const photoInput = document.querySelector('#shopping-list-photo');
  const photoPreview = document.querySelector('#photo-preview');
  const photoPreviewImage = document.querySelector('#photo-preview-image');
  const scanButton = document.querySelector('#scan-photo');
  const useScanButton = document.querySelector('#use-scan');
  const scanStatus = document.querySelector('#scan-status');
  const scanResults = document.querySelector('#scan-results');
  const scanCoordinateList = document.querySelector('#scan-coordinate-list');
  let selectedPhoto = null;
  let photoObjectUrl = '';
  let scannedCoordinates = [];
  let resizeFrame = 0;

  function maximumScaleFor(rect) {
    // At maximum zoom, retain about four complete grid squares along the
    // constrained viewport dimension. The other dimension shows more when
    // the viewport is not square.
    return Math.max(
      state.minScale,
      Math.min(rect.width / (MAP.cellX * 4), rect.height / (MAP.cellY * 4))
    );
  }

  function resizeCanvas() {
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const hadViewport = state.viewportWidth > 0 && state.viewportHeight > 0;
    const centerMapX = hadViewport ? (state.viewportWidth / 2 - state.x) / state.scale : MAP.width / 2;
    const centerMapY = hadViewport ? (state.viewportHeight / 2 - state.y) / state.scale : MAP.height / 2;
    const relativeZoom = hadViewport && state.minScale > 0 ? state.scale / state.minScale : 1;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    state.viewportWidth = rect.width;
    state.viewportHeight = rect.height;
    state.minScale = Math.min(rect.width / MAP.width, rect.height / MAP.height);
    state.maxScale = maximumScaleFor(rect);
    state.scale = Math.min(state.maxScale, Math.max(state.minScale, state.minScale * relativeZoom));
    state.x = rect.width / 2 - centerMapX * state.scale;
    state.y = rect.height / 2 - centerMapY * state.scale;
    clampView();
    draw();
  }

  function scheduleCanvasResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(resizeCanvas);
  }

  function fitMap(redraw = true) {
    const rect = viewport.getBoundingClientRect();
    state.minScale = Math.min(rect.width / MAP.width, rect.height / MAP.height);
    state.maxScale = maximumScaleFor(rect);
    state.scale = state.minScale;
    state.x = (rect.width - MAP.width * state.scale) / 2;
    state.y = (rect.height - MAP.height * state.scale) / 2;
    if (redraw) draw();
  }

  function clampView() {
    const rect = viewport.getBoundingClientRect();
    const w = MAP.width * state.scale;
    const h = MAP.height * state.scale;
    state.x = w <= rect.width ? (rect.width - w) / 2 : Math.min(0, Math.max(rect.width - w, state.x));
    state.y = h <= rect.height ? (rect.height - h) / 2 : Math.min(0, Math.max(rect.height - h, state.y));
  }

  function draw() {
    const rect = viewport.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!state.mapReady) return;
    ctx.save();
    ctx.translate(state.x, state.y);
    ctx.scale(state.scale, state.scale);
    drawTiles();

    state.points.forEach((point) => {
      const x = MAP.left + point.e * MAP.cellX;
      const y = MAP.bottom - (point.n + 1) * MAP.cellY;
      // FIA coordinates name the lower-left grid-line intersection.
      // The associated search square extends east (right) and north (up).
      const cx = x;
      const cy = y + MAP.cellY;
      // Tint the entire 1 km square and keep its border legible at every zoom level.
      ctx.fillStyle = `${point.color}70`;
      ctx.fillRect(x, y, MAP.cellX, MAP.cellY);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 4.5 / state.scale;
      ctx.strokeRect(x, y, MAP.cellX, MAP.cellY);
      ctx.strokeStyle = point.color;
      ctx.lineWidth = 2.5 / state.scale;
      ctx.strokeRect(x, y, MAP.cellX, MAP.cellY);

      const radius = Math.max(11 / state.scale, MAP.cellX * .31);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = point.color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2 / state.scale;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${Math.max(12 / state.scale, 8)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(point.index + 1), cx, cy + .3 / state.scale);
    });
    ctx.restore();
    drawCoordinateOverlay(rect);
  }

  function adaptiveGridStep() {
    const targetSpacing = 72;
    const minimumStep = targetSpacing / (MAP.cellX * state.scale);
    return [1, 2, 5, 10, 20, 25, 50, 100].find((step) => step >= minimumStep) || 100;
  }

  function drawCoordinateOverlay(rect) {
    const step = adaptiveGridStep();
    const mapLeft = state.x + MAP.left * state.scale;
    const mapRight = state.x + MAP.right * state.scale;
    const mapTop = state.y + MAP.top * state.scale;
    const mapBottom = state.y + MAP.bottom * state.scale;
    const visibleLeft = Math.max(0, mapLeft);
    const visibleRight = Math.min(rect.width, mapRight);
    const visibleTop = Math.max(0, mapTop);
    const visibleBottom = Math.min(rect.height, mapBottom);
    if (visibleLeft >= visibleRight || visibleTop >= visibleBottom) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop);
    ctx.clip();
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(239,199,94,.26)';

    const firstE = Math.max(MAP.minE, Math.ceil(((0 - state.x) / state.scale - MAP.left) / MAP.cellX));
    const lastE = Math.min(MAP.maxE + 1, Math.floor(((rect.width - state.x) / state.scale - MAP.left) / MAP.cellX));
    for (let e = Math.ceil(firstE / step) * step; e <= lastE; e += step) {
      const x = state.x + (MAP.left + e * MAP.cellX) * state.scale;
      ctx.beginPath(); ctx.moveTo(x, visibleTop); ctx.lineTo(x, visibleBottom); ctx.stroke();
    }

    const firstN = Math.max(MAP.minN, Math.ceil((MAP.bottom - (rect.height - state.y) / state.scale) / MAP.cellY));
    const lastN = Math.min(MAP.maxN + 1, Math.floor((MAP.bottom - (0 - state.y) / state.scale) / MAP.cellY));
    for (let n = Math.ceil(firstN / step) * step; n <= lastN; n += step) {
      const y = state.y + (MAP.bottom - n * MAP.cellY) * state.scale;
      ctx.beginPath(); ctx.moveTo(visibleLeft, y); ctx.lineTo(visibleRight, y); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.font = '800 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const labelTop = Math.max(62, visibleTop + 17);
    const labelLeft = Math.max(6, visibleLeft + 6);

    for (let e = Math.ceil(firstE / step) * step; e <= lastE; e += step) {
      const x = state.x + (MAP.left + e * MAP.cellX) * state.scale;
      const text = `E ${String(e).padStart(3, '0')}`;
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(13,18,15,.82)';
      ctx.fillRect(x - width / 2, labelTop - 10, width, 20);
      ctx.fillStyle = '#f1cf73';
      ctx.textAlign = 'center';
      ctx.fillText(text, x, labelTop);
    }

    for (let n = Math.ceil(firstN / step) * step; n <= lastN; n += step) {
      const y = state.y + (MAP.bottom - n * MAP.cellY) * state.scale;
      const text = `N ${String(n).padStart(3, '0')}`;
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(13,18,15,.82)';
      ctx.fillRect(labelLeft, y - 10, width, 20);
      ctx.fillStyle = '#f1cf73';
      ctx.textAlign = 'left';
      ctx.fillText(text, labelLeft + 5, y);
    }
    ctx.restore();
  }

  function getTile(level, column, row) {
    const key = `${level.level}/${column}-${row}`;
    if (tileCache.has(key)) {
      const cached = tileCache.get(key);
      cached.lastUsed = performance.now();
      return cached;
    }
    const tile = new Image();
    const record = { image: tile, loaded: false, lastUsed: performance.now() };
    tileCache.set(key, record);
    tile.addEventListener('load', () => {
      record.loaded = true;
      if (level.level === 0) {
        state.mapReady = true;
        loading.hidden = true;
        resizeCanvas();
        restore();
      }
      pruneTileCache();
      draw();
    });
    tile.src = `assets/map-tiles/${level.level}/${column}-${row}.jpg`;
    return record;
  }

  function pruneTileCache() {
    if (tileCache.size <= MAX_CACHED_TILES) return;
    const removable = [...tileCache.entries()]
      .filter(([key, record]) => key !== '0/0-0' && record.loaded)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (tileCache.size > MAX_CACHED_TILES && removable.length) {
      const [key, record] = removable.shift();
      record.image.src = '';
      tileCache.delete(key);
    }
  }

  function drawLevel(level, visibleOnly) {
    const ratio = level.ratio;
    const columns = Math.ceil(level.size / TILE_SIZE);
    let firstColumn = 0;
    let lastColumn = columns - 1;
    let firstRow = 0;
    let lastRow = columns - 1;
    if (visibleOnly) {
      const rect = viewport.getBoundingClientRect();
      const left = Math.max(0, -state.x / state.scale);
      const top = Math.max(0, -state.y / state.scale);
      const right = Math.min(MAP.width, (rect.width - state.x) / state.scale);
      const bottom = Math.min(MAP.height, (rect.height - state.y) / state.scale);
      firstColumn = Math.max(0, Math.floor(left * ratio / TILE_SIZE));
      lastColumn = Math.min(columns - 1, Math.floor(right * ratio / TILE_SIZE));
      firstRow = Math.max(0, Math.floor(top * ratio / TILE_SIZE));
      lastRow = Math.min(columns - 1, Math.floor(bottom * ratio / TILE_SIZE));
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const record = getTile(level, column, row);
        if (!record.loaded) continue;
        const x = column * TILE_SIZE / ratio;
        const y = row * TILE_SIZE / ratio;
        ctx.drawImage(record.image, x, y, record.image.naturalWidth / ratio + .5, record.image.naturalHeight / ratio + .5);
      }
    }
  }

  function drawTiles() {
    drawLevel(LEVELS[0], false);
    const selected = LEVELS.find((level) => level.ratio >= state.scale) || LEVELS[LEVELS.length - 1];
    if (selected.level > 0) drawLevel(selected, true);
  }

  function normalize(value) {
    const clean = value.replace(/\D/g, '').slice(0, 3);
    return clean ? clean.padStart(3, '0') : '';
  }

  function parseRows() {
    const points = [];
    rowEls.forEach((row, index) => {
      row.classList.remove('invalid');
      row.querySelector('.row-error')?.remove();
      const [eInput, nInput] = row.querySelectorAll('input');
      const eRaw = eInput.value.trim();
      const nRaw = nInput.value.trim();
      if (!eRaw && !nRaw) return;
      eInput.value = normalize(eRaw);
      nInput.value = normalize(nRaw);
      const e = Number(eInput.value);
      const n = Number(nInput.value);
      let message = '';
      if (!eRaw || !nRaw) message = 'Enter both values.';
      else if (!/^\d{1,3}$/.test(eRaw) || !/^\d{1,3}$/.test(nRaw)) message = 'Use 1–3 digits in each field.';
      else if (e < MAP.minE || e > MAP.maxE || n < MAP.minN || n > MAP.maxN) message = `Outside this map (E 000–135, N 000–129).`;
      if (message) {
        row.classList.add('invalid');
        row.insertAdjacentHTML('beforeend', `<p class="row-error" role="alert">${message}</p>`);
      } else {
        points.push({ index, e, n, code: `${String(e).padStart(3, '0')} ${String(n).padStart(3, '0')}`, color: COLORS[index] });
      }
    });
    return points;
  }

  function updateLegend() {
    count.textContent = String(state.points.length);
    shareButton.hidden = state.points.length !== 5;
    if (shareButton.hidden) shareStatus.textContent = '';
    if (!state.points.length) {
      legend.innerHTML = '<p class="empty-state">No locations plotted yet.</p>';
      return;
    }
    legend.innerHTML = state.points.map((p) => `
      <button class="legend-item" type="button" data-index="${p.index}" aria-label="Focus location ${p.index + 1}, ${p.code}">
        <span class="marker-swatch" style="background:${p.color}">${p.index + 1}</span>
        <span class="legend-code">${p.code}</span>
        <span class="legend-hint">Focus →</span>
      </button>`).join('');
  }

  function shareUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('locations', [...state.points]
      .sort((a, b) => a.index - b.index)
      .map((point) => `${String(point.e).padStart(3, '0')}${String(point.n).padStart(3, '0')}`)
      .join(','));
    return url.href;
  }

  async function copyShareUrl(url) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(url);
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('Copy failed');
  }

  function sharedCoordinates() {
    const encoded = new URL(location.href).searchParams.get('locations');
    if (!encoded) return null;
    const entries = encoded.split(',');
    if (entries.length !== 5 || entries.some((entry) => !/^\d{6}$/.test(entry))) return null;
    const pairs = entries.map((entry) => [Number(entry.slice(0, 3)), Number(entry.slice(3))]);
    if (pairs.some(([easting, northing]) => easting < MAP.minE || easting > MAP.maxE || northing < MAP.minN || northing > MAP.maxN)) return null;
    return pairs;
  }

  function save() {
    localStorage.setItem('everon-fia-coordinates', JSON.stringify(rowEls.map((row) => [...row.querySelectorAll('input')].map((input) => input.value))));
  }

  function restore() {
    try {
      const shared = sharedCoordinates();
      const saved = shared || JSON.parse(localStorage.getItem('everon-fia-coordinates'));
      if (!Array.isArray(saved)) return;
      saved.slice(0, 5).forEach((pair, i) => {
        const fields = rowEls[i].querySelectorAll('input');
        fields[0].value = pair?.[0] || '';
        fields[1].value = pair?.[1] || '';
      });
      state.points = parseRows();
      updateLegend();
      if (shared) save();
      if (state.points.length) fitPoints(state.points);
    } catch (_) { /* Ignore malformed browser storage. */ }
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const old = state.scale;
    const next = Math.min(state.maxScale, Math.max(state.minScale, old * factor));
    state.x = px - (px - state.x) * (next / old);
    state.y = py - (py - state.y) * (next / old);
    state.scale = next;
    clampView();
    draw();
  }

  function focusPoint(point) {
    const rect = viewport.getBoundingClientRect();
    const cx = MAP.left + (point.e + .5) * MAP.cellX;
    const cy = MAP.bottom - (point.n + .5) * MAP.cellY;
    state.scale = Math.min(state.maxScale, Math.max(state.minScale * 5, .7));
    state.x = rect.width / 2 - cx * state.scale;
    state.y = rect.height / 2 - cy * state.scale;
    clampView();
    draw();
  }

  function focusMarkerAt(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    let closest = null;
    let closestDistance = Infinity;
    for (const point of state.points) {
      const markerX = rect.left + state.x + (MAP.left + point.e * MAP.cellX) * state.scale;
      const markerY = rect.top + state.y + (MAP.bottom - point.n * MAP.cellY) * state.scale;
      const distance = Math.hypot(clientX - markerX, clientY - markerY);
      const hitRadius = Math.max(28, MAP.cellX * .4 * state.scale);
      if (distance <= hitRadius && distance < closestDistance) {
        closest = point;
        closestDistance = distance;
      }
    }
    if (closest) focusPoint(closest);
    return Boolean(closest);
  }

  function fitPoints(points) {
    if (!points.length) return;
    if (points.length === 1) {
      focusPoint(points[0]);
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const left = Math.min(...points.map((point) => MAP.left + point.e * MAP.cellX));
    const right = Math.max(...points.map((point) => MAP.left + (point.e + 1) * MAP.cellX));
    const top = Math.min(...points.map((point) => MAP.bottom - (point.n + 1) * MAP.cellY));
    const bottom = Math.max(...points.map((point) => MAP.bottom - point.n * MAP.cellY));
    const contentWidth = Math.max(MAP.cellX, right - left);
    const contentHeight = Math.max(MAP.cellY, bottom - top);
    const mapPadding = Math.max(MAP.cellX * 2.5, Math.max(contentWidth, contentHeight) * .12);
    const availableWidth = Math.max(120, rect.width - 80);
    const availableHeight = Math.max(120, rect.height - 100);
    const nextScale = Math.min(
      availableWidth / (contentWidth + mapPadding * 2),
      availableHeight / (contentHeight + mapPadding * 2)
    );

    state.scale = Math.min(state.maxScale, Math.max(state.minScale, nextScale));
    state.x = rect.width / 2 - ((left + right) / 2) * state.scale;
    state.y = rect.height / 2 - ((top + bottom) / 2) * state.scale;
    clampView();
    draw();
  }

  function showCursor(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const mx = (clientX - rect.left - state.x) / state.scale;
    const my = (clientY - rect.top - state.y) / state.scale;
    const e = Math.floor((mx - MAP.left) / MAP.cellX);
    const n = Math.floor((MAP.bottom - my) / MAP.cellY);
    if (e >= MAP.minE && e <= MAP.maxE && n >= MAP.minN && n <= MAP.maxN) {
      readout.innerHTML = `<span class="status-dot"></span>Grid ${String(e).padStart(3, '0')} ${String(n).padStart(3, '0')}`;
    } else {
      readout.innerHTML = '<span class="status-dot"></span>Outside map grid';
    }
  }

  function setScanStatus(message, isError = false) {
    scanStatus.textContent = message;
    scanStatus.classList.toggle('error', isError);
  }

  function resetScanResults() {
    scannedCoordinates = [];
    scanResults.hidden = true;
    useScanButton.hidden = true;
    scanCoordinateList.replaceChildren();
  }

  function applyScannedCoordinates() {
    rowEls.forEach((row, index) => {
      const [easting, northing] = row.querySelectorAll('input');
      const coordinate = scannedCoordinates[index];
      easting.value = coordinate ? String(coordinate.easting).padStart(3, '0') : '';
      northing.value = coordinate ? String(coordinate.northing).padStart(3, '0') : '';
    });
    scannerDialog.close();
    document.querySelector('#coordinate-form').requestSubmit();
    requestAnimationFrame(() => viewport.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image format could not be read. Try taking a JPG photo.')); };
      img.src = url;
    });
  }

  async function preparePhoto(file) {
    const image = await loadImageFile(file);
    const maximumSide = 3200;
    const ratio = Math.min(1, maximumSide / Math.max(image.naturalWidth, image.naturalHeight));
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    output.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    output.getContext('2d').drawImage(image, 0, 0, output.width, output.height);
    return output.toDataURL('image/jpeg', .9);
  }

  document.querySelector('#open-scanner').addEventListener('click', () => {
    setScanStatus('');
    scannerDialog.showModal();
  });

  scannerDialog.addEventListener('close', () => {
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = '';
    photoPreviewImage.removeAttribute('src');
    photoPreview.hidden = true;
    photoInput.value = '';
    selectedPhoto = null;
    scanButton.disabled = true;
    resetScanResults();
    setScanStatus('');
  });

  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    resetScanResults();
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setScanStatus('Choose an image file.', true);
      return;
    }
    selectedPhoto = file;
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = URL.createObjectURL(file);
    photoPreviewImage.src = photoObjectUrl;
    photoPreview.hidden = false;
    scanButton.disabled = false;
    setScanStatus('Photo ready. Starting OCR…');
    scanSelectedPhoto();
  });

  async function scanSelectedPhoto() {
    if (!selectedPhoto) return;
    scanButton.disabled = true;
    resetScanResults();
    setScanStatus('Reading the shopping list…');
    try {
      if (location.protocol === 'file:') throw new Error('Scanning is available when the app is opened from your HTTPS server. Manual entry still works here.');
      const image = await preparePhoto(selectedPhoto);
      const response = await fetch('api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The photo could not be scanned.');
      if (data.version !== APP_VERSION) {
        throw new Error(`The page is ${APP_VERSION || 'newer'}, but the OCR server is ${data.version || 'an older release'}. Restart the app in GoDaddy, then try again.`);
      }
      scannedCoordinates = (data.coordinates || []).filter((item) =>
        Number.isInteger(item.easting) && Number.isInteger(item.northing) &&
        item.easting >= MAP.minE && item.easting <= MAP.maxE &&
        item.northing >= MAP.minN && item.northing <= MAP.maxN
      ).slice(0, 5);
      if (!scannedCoordinates.length) throw new Error('No valid FIA coordinates were found. Try a clearer, closer photo.');
      if (scannedCoordinates.length === 5) {
        applyScannedCoordinates();
        return;
      }
      scanCoordinateList.replaceChildren(...scannedCoordinates.map((item) => {
        const chip = document.createElement('span');
        chip.className = 'scan-coordinate';
        chip.textContent = `${String(item.easting).padStart(3, '0')} ${String(item.northing).padStart(3, '0')}`;
        return chip;
      }));
      scanResults.hidden = false;
      useScanButton.hidden = false;
      setScanStatus(`${scannedCoordinates.length} coordinate${scannedCoordinates.length === 1 ? '' : 's'} found. Check them before continuing.`);
    } catch (error) {
      setScanStatus(error.message || 'The photo could not be scanned.', true);
    } finally {
      scanButton.disabled = false;
    }
  }

  scanButton.addEventListener('click', scanSelectedPhoto);

  useScanButton.addEventListener('click', applyScannedCoordinates);

  shareButton.addEventListener('click', async () => {
    if (state.points.length !== 5) return;
    const url = shareUrl();
    const data = { url };
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
        await navigator.share(data);
        shareStatus.textContent = 'Team link shared.';
      } else {
        await copyShareUrl(url);
        shareStatus.textContent = 'Team link copied to clipboard.';
      }
    } catch (error) {
      if (error?.name !== 'AbortError') shareStatus.textContent = 'Could not share automatically. Try again.';
    }
  });

  document.querySelector('#coordinate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.points = parseRows();
    updateLegend();
    save();
    if (state.points.length) fitPoints(state.points);
    else draw();
  });

  inputs.forEach((input) => {
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 3); });
    input.addEventListener('blur', () => { input.value = normalize(input.value); });
  });

  document.querySelector('#clear-button').addEventListener('click', () => {
    inputs.forEach((input) => { input.value = ''; });
    rowEls.forEach((row) => { row.classList.remove('invalid'); row.querySelector('.row-error')?.remove(); });
    state.points = [];
    localStorage.removeItem('everon-fia-coordinates');
    updateLegend();
    draw();
  });

  mapTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.map-tab');
    if (!tab) return;
    if (tab.dataset.map === 'kolguyev') {
      mapTabMessage.hidden = false;
      document.querySelector('#everon-tab').focus();
      return;
    }
    mapTabMessage.hidden = true;
  });

  legend.addEventListener('click', (event) => {
    const button = event.target.closest('.legend-item');
    if (!button) return;
    const point = state.points.find((p) => p.index === Number(button.dataset.index));
    if (point) focusPoint(point);
  });

  viewport.addEventListener('wheel', (event) => { event.preventDefault(); zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * .0012)); }, { passive: false });
  viewport.addEventListener('dblclick', (event) => zoomAt(event.clientX, event.clientY, 1.8));
  viewport.addEventListener('pointerdown', (event) => {
    viewport.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 1) {
      state.pointerStartX = event.clientX;
      state.pointerStartY = event.clientY;
      state.pointerMoved = false;
    } else {
      state.pointerMoved = true;
    }
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    showCursor(event.clientX, event.clientY);
    if (!state.pointers.has(event.pointerId)) return;
    if (Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY) > 8) state.pointerMoved = true;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (state.pinchDistance) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, distance / state.pinchDistance);
      state.pinchDistance = distance;
    } else {
      state.x += event.clientX - state.lastX;
      state.y += event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      clampView();
      draw();
    }
  });
  function endPointer(event) {
    const isMarkerTap = !state.pointerMoved && state.pointers.size === 1;
    state.pointers.delete(event.pointerId);
    state.pinchDistance = 0;
    if (!state.pointers.size) { state.dragging = false; viewport.classList.remove('dragging'); }
    else { const p = [...state.pointers.values()][0]; state.lastX = p.x; state.lastY = p.y; }
    if (isMarkerTap) focusMarkerAt(event.clientX, event.clientY);
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('pointerleave', () => {
    if (!state.dragging) readout.innerHTML = '<span class="status-dot"></span>Move over the map';
  });

  document.querySelector('#zoom-in').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.5); });
  document.querySelector('#zoom-out').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.5); });
  document.querySelector('#reset-view').addEventListener('click', () => fitMap());
  window.addEventListener('resize', scheduleCanvasResize);
  new ResizeObserver(scheduleCanvasResize).observe(viewport);

  getTile(LEVELS[0], 0, 0).image.addEventListener('error', () => { loading.textContent = 'Map tiles could not be loaded.'; });
})();
