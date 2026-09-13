'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const OCR_CACHE = path.join(ROOT, '.ocr-cache');
const MAX_BODY = 12 * 1024 * 1024;
const OCR_RATE_LIMIT = Math.max(1, Number.parseInt(process.env.OCR_RATE_LIMIT || '3', 10) || 3);
const requestLog = new Map();
let workerPromise;
let ocrQueue = Promise.resolve();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function secureHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(self)');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function withinRateLimit(address) {
  const now = Date.now();
  const recent = (requestLog.get(address) || []).filter((time) => now - time < 60_000);
  if (recent.length >= OCR_RATE_LIMIT) return false;
  recent.push(now);
  requestLog.set(address, recent);
  return true;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('PHOTO_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

async function getOcrWorker() {
  if (!workerPromise) {
    fs.mkdirSync(OCR_CACHE, { recursive: true });
    const options = { cachePath: OCR_CACHE };
    if (process.env.OCR_DEBUG === '1') options.logger = (message) => console.log('OCR:', message.status, message.progress || '');
    workerPromise = createWorker('eng', 1, options).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function extractCoordinates(text) {
  const coordinates = [];

  function addPair(target, eastingText, northingText) {
    const easting = Number(eastingText);
    const northing = Number(northingText);
    if (Number.isInteger(easting) && Number.isInteger(northing) &&
        easting >= 0 && easting <= 135 && northing >= 0 && northing <= 129) {
      target.push({ easting, northing });
      return true;
    }
    return false;
  }

  // Prefer one shopping-list row at a time. Removing OCR-inserted spaces lets
  // values such as "0 65 0 31" recover as the intended "065 031".
  for (const line of text.split(/\r?\n/)) {
    if (coordinates.length >= 5) break;
    const digits = line.replace(/\D/g, '');
    if (digits.length === 6) addPair(coordinates, digits.slice(0, 3), digits.slice(3));
    else if (digits.length >= 4 && digits.length <= 5) {
      // If OCR drops leading zeroes, try every plausible split and retain the
      // unique pair that falls inside Everon's coordinate range.
      const candidates = [];
      for (let split = 1; split < digits.length; split += 1) {
        const easting = Number(digits.slice(0, split));
        const northing = Number(digits.slice(split));
        if (easting <= 135 && northing <= 129 && split <= 3 && digits.length - split <= 3) {
          candidates.push({ easting, northing });
        }
      }
      if (candidates.length === 1) coordinates.push(candidates[0]);
    }
  }

  // Fallback for OCR output that combines every row into one continuous line.
  const tokens = text.match(/\d{3}/g) || [];
  const continuousCoordinates = [];
  for (let index = 0; index + 1 < tokens.length && continuousCoordinates.length < 5; index += 2) {
    addPair(continuousCoordinates, tokens[index], tokens[index + 1]);
  }
  return (continuousCoordinates.length > coordinates.length ? continuousCoordinates : coordinates).slice(0, 5);
}

async function recognizeCoordinates(image) {
  const worker = await getOcrWorker();
  const attempts = [];
  for (const pageMode of ['6', '11']) {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789 ',
      tessedit_pageseg_mode: pageMode,
      preserve_interword_spaces: '1'
    });
    const result = await worker.recognize(image, { rotateAuto: true });
    if (process.env.OCR_DEBUG === '1') console.log('OCR text:', JSON.stringify(result.data.text));
    attempts.push(extractCoordinates(result.data.text));
    if (attempts.at(-1).length === 5) break;
  }
  return attempts.sort((a, b) => b.length - a.length)[0] || [];
}

function queueRecognition(image) {
  const task = ocrQueue.then(() => recognizeCoordinates(image));
  ocrQueue = task.catch(() => undefined);
  return task;
}

async function scanShoppingList(request, response) {
  if (!withinRateLimit(request.socket.remoteAddress || 'unknown')) return sendJson(response, 429, { error: 'Too many scans. Wait a minute and try again.' });

  let body;
  try { body = await readJson(request); }
  catch (error) {
    return sendJson(response, error.message === 'PHOTO_TOO_LARGE' ? 413 : 400, { error: 'The uploaded photo is invalid or too large.' });
  }
  if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/i.test(body.image)) {
    return sendJson(response, 400, { error: 'A JPG, PNG, or WebP photo is required.' });
  }

  let imageBuffer;
  try {
    const base64 = body.image.slice(body.image.indexOf(',') + 1);
    body.image = '';
    imageBuffer = Buffer.from(base64, 'base64');
    const coordinates = await queueRecognition(imageBuffer);
    return sendJson(response, 200, { coordinates });
  } catch (error) {
    console.error('Local OCR failure:', error.message);
    return sendJson(response, 502, { error: 'The OCR service could not read the photo. Try again.' });
  } finally {
    if (imageBuffer) imageBuffer.fill(0);
    if (body) body.image = '';
  }
}

const server = http.createServer(async (request, response) => {
  secureHeaders(response);
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/scan') return scanShoppingList(request, response);
  if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { error: 'Method not allowed.' });

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(ROOT, requested);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return sendJson(response, 403, { error: 'Forbidden.' });
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return sendJson(response, 404, { error: 'Not found.' });
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': /map-tiles|Everon-1989/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
});

server.listen(PORT, () => console.log(`FIA CaM listening on port ${PORT}`));
