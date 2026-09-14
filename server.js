'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');
const { version: APP_VERSION } = require('./package.json');

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
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'sha256-KEQ6B0LvrIrYohGkglrRNA+UoR2G6XWwGjMtLujLrWI='; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
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

function targetRectanglesFromTsv(tsv) {
  if (typeof tsv !== 'string' || !tsv.trim()) return [];
  const rows = tsv.trim().split(/\r?\n/).map((line) => line.split('\t'));
  const page = rows.find((row) => row[0] === '1');
  const imageWidth = Number(page?.[8]);
  const imageHeight = Number(page?.[9]);
  if (!imageWidth || !imageHeight) return [];

  return rows
    .filter((row) => row[0] === '5' && (row[11] || '').replace(/\D/g, '').length >= 4)
    .sort((a, b) => Number(b[10]) - Number(a[10]))
    .map((row) => {
      const left = Number(row[6]);
      const top = Number(row[7]);
      const width = Number(row[8]);
      const height = Number(row[9]);
      const regionWidth = Math.min(imageWidth, Math.max(width * 6, imageWidth * .18));
      const regionHeight = Math.min(imageHeight, Math.max(height * 16, imageHeight * .18));
      return {
        left: Math.max(0, Math.round(left + width / 2 - regionWidth / 2)),
        top: Math.max(0, Math.round(top + height / 2 - regionHeight / 2)),
        width: Math.round(regionWidth),
        height: Math.round(regionHeight)
      };
    })
    .map((rectangle) => ({
      ...rectangle,
      width: Math.min(rectangle.width, imageWidth - rectangle.left),
      height: Math.min(rectangle.height, imageHeight - rectangle.top)
    }))
    .filter((rectangle, index, rectangles) =>
      rectangles.findIndex((candidate) =>
        Math.abs(candidate.left - rectangle.left) < imageWidth * .05 &&
        Math.abs(candidate.top - rectangle.top) < imageHeight * .05
      ) === index
    )
    .slice(0, 2);
}

function headingRectangleFromTsv(tsv) {
  if (typeof tsv !== 'string' || !tsv.trim()) return null;
  const rows = tsv.trim().split(/\r?\n/).map((line) => line.split('\t'));
  const page = rows.find((row) => row[0] === '1');
  const imageWidth = Number(page?.[8]);
  const imageHeight = Number(page?.[9]);
  if (!imageWidth || !imageHeight) return null;

  const words = rows
    .filter((row) => row[0] === '5' && Number(row[10]) >= 15 && row[11])
    .map((row) => ({
      line: row.slice(1, 5).join(':'),
      text: row[11].toLowerCase().replace(/[^a-z]/g, ''),
      left: Number(row[6]), top: Number(row[7]), width: Number(row[8]), height: Number(row[9])
    }));

  function resembles(actual, expected) {
    if (actual === expected || actual.includes(expected) || expected.includes(actual) && actual.length >= expected.length - 2) return true;
    if (Math.abs(actual.length - expected.length) > 2) return false;
    const costs = Array.from({ length: expected.length + 1 }, (_, index) => index);
    for (let i = 1; i <= actual.length; i += 1) {
      let previous = costs[0];
      costs[0] = i;
      for (let j = 1; j <= expected.length; j += 1) {
        const saved = costs[j];
        costs[j] = Math.min(costs[j] + 1, costs[j - 1] + 1, previous + (actual[i - 1] === expected[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return costs[expected.length] <= 2;
  }

  for (let index = 0; index < words.length; index += 1) {
    const first = words[index];
    const combinedHeading = resembles(first.text, 'shoppinglist');
    if (!combinedHeading && !resembles(first.text, 'shopping')) continue;
    const second = combinedHeading ? first : words.slice(index + 1, index + 4).find((word) => word.line === first.line && resembles(word.text, 'list'));
    if (!second) continue;
    const headingLeft = Math.min(first.left, second.left);
    const headingRight = Math.max(first.left + first.width, second.left + second.width);
    const headingBottom = Math.max(first.top + first.height, second.top + second.height);
    const headingWidth = headingRight - headingLeft;
    const headingHeight = Math.max(first.height, second.height);
    const regionWidth = Math.min(imageWidth, Math.max(headingWidth * 2.8, imageWidth * .24));
    const left = Math.max(0, Math.round((headingLeft + headingRight) / 2 - regionWidth / 2));
    const top = Math.max(0, Math.round(headingBottom - headingHeight * .15));
    return {
      left,
      top,
      width: Math.min(Math.round(regionWidth), imageWidth - left),
      height: Math.min(Math.round(Math.max(headingHeight * 15, imageHeight * .28)), imageHeight - top)
    };
  }
  return null;
}

async function recognizeCoordinates(image) {
  const worker = await getOcrWorker();
  const attempts = [];
  const targetRectangles = [];

  // Find the stable in-game heading first, then read the five rows beneath it.
  // This removes unrelated HUD numbers while retaining whole-image fallbacks.
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
    tessedit_pageseg_mode: '11',
    preserve_interword_spaces: '1',
    user_defined_dpi: '300'
  });
  const headingPass = await worker.recognize(image, { rotateAuto: false }, { text: true, tsv: true });
  attempts.push(extractCoordinates(headingPass.data.text));
  const headingRectangle = headingRectangleFromTsv(headingPass.data.tsv);
  if (process.env.OCR_DEBUG === '1') console.log('Heading OCR:', headingRectangle, JSON.stringify(headingPass.data.text));
  if (attempts.at(-1).length === 5) return attempts.at(-1);

  if (headingRectangle && !attempts.some((attempt) => attempt.length === 5)) {
    for (const pageMode of ['6', '11']) {
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789 ',
        tessedit_pageseg_mode: pageMode
      });
      const result = await worker.recognize(image, { rectangle: headingRectangle });
      if (process.env.OCR_DEBUG === '1') console.log('Heading-targeted OCR:', headingRectangle, JSON.stringify(result.data.text));
      attempts.push(extractCoordinates(result.data.text));
      if (attempts.at(-1).length === 5) return attempts.at(-1);
    }
  }

  for (const pageMode of ['6', '11']) {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789 ',
      tessedit_pageseg_mode: pageMode,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });
    const result = await worker.recognize(image, { rotateAuto: false }, { text: true, tsv: true });
    if (process.env.OCR_DEBUG === '1') console.log('OCR text:', JSON.stringify(result.data.text));
    attempts.push(extractCoordinates(result.data.text));
    targetRectangles.push(...targetRectanglesFromTsv(result.data.tsv));
    if (attempts.at(-1).length === 5) break;
  }

  const uniqueTargets = targetRectangles.filter((rectangle, index, rectangles) =>
    rectangles.findIndex((candidate) =>
      Math.abs(candidate.left - rectangle.left) < 40 &&
      Math.abs(candidate.top - rectangle.top) < 40
    ) === index
  ).slice(0, 2);

  if (!attempts.some((attempt) => attempt.length === 5)) {
    for (const rectangle of uniqueTargets) {
      for (const pageMode of ['6', '11']) {
        await worker.setParameters({ tessedit_pageseg_mode: pageMode });
        const result = await worker.recognize(image, { rectangle });
        if (process.env.OCR_DEBUG === '1') console.log('Targeted OCR:', rectangle, JSON.stringify(result.data.text));
        attempts.push(extractCoordinates(result.data.text));
        if (attempts.at(-1).length === 5) break;
      }
      if (attempts.at(-1).length === 5) break;
    }
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
    return sendJson(response, 200, { coordinates, version: APP_VERSION });
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
  if (request.method === 'GET' && url.pathname === '/api/status') return sendJson(response, 200, { version: APP_VERSION });
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
