import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseHtmlDom } from './scripts/html-dom.mjs';
import { parseSyncShareDocument } from './src/js/syncshare-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '4173', 10);
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB for multi-HTML upload
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'ocg_admin_session';

const BASE_QUESTIONS_PATH = path.join(__dirname, 'src', 'data', 'questions.json');
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOM_TOPICS_PATH = path.join(DATA_DIR, 'custom-topics.json');
const SESSION_SECRET_PATH = path.join(DATA_DIR, '.session-secret');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const PUBLIC_PREFIXES = ['src/', 'assets/', 'dist/'];
const PUBLIC_EXACT = new Set(['index.html', 's_guap-sign.svg']);

function getAdminPassword() {
  const configured = process.env.ADMIN_PASSWORD;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return null;
}

function getSessionSecret() {
  if (process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.trim().length > 0) {
    return process.env.ADMIN_SESSION_SECRET.trim();
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSION_SECRET_PATH)) {
    const existing = fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret, 'utf8');
  return secret;
}

function sha256Buffer(val) {
  return crypto.createHash('sha256').update(String(val), 'utf8').digest();
}

function verifyPassword(inputPassword) {
  const password = getAdminPassword();
  if (!password) return false;
  const a = sha256Buffer(inputPassword || '');
  const b = sha256Buffer(password);
  return crypto.timingSafeEqual(a, b);
}

function signSessionToken() {
  const secret = getSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({ role: 'admin', exp: Date.now() + SESSION_TTL_MS }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.role === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// Simple in-memory rate limiter for failed admin logins
const loginFailures = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec) return { allowed: true };
  if (rec.blockedUntil && rec.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.blockedUntil - now) / 1000) };
  }
  if (now - rec.windowStart > 5 * 60 * 1000) {
    loginFailures.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec || now - rec.windowStart > 5 * 60 * 1000) {
    loginFailures.set(ip, { count: 1, windowStart: now, blockedUntil: 0 });
    return;
  }
  rec.count++;
  if (rec.count >= 5) {
    rec.blockedUntil = now + 60 * 1000;
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function readCustomEntries(customPath = CUSTOM_TOPICS_PATH) {
  try {
    if (!fs.existsSync(customPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCustomEntries(entries, customPath = CUSTOM_TOPICS_PATH) {
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  const tmpPath = `${customPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, customPath);
}

export function buildMergedDataset(customPath = CUSTOM_TOPICS_PATH) {
  const base = JSON.parse(fs.readFileSync(BASE_QUESTIONS_PATH, 'utf8'));
  const customEntries = readCustomEntries(customPath);

  const topicMap = new Map();
  const questionsByTopic = new Map();

  for (const t of base.topics || []) {
    topicMap.set(t.id, { ...t, isCustom: false });
    questionsByTopic.set(t.id, []);
  }
  for (const q of base.questions || []) {
    if (!questionsByTopic.has(q.topicId)) questionsByTopic.set(q.topicId, []);
    questionsByTopic.get(q.topicId).push(q);
  }

  for (const entry of customEntries) {
    if (!entry || !entry.topic || !Array.isArray(entry.questions)) continue;
    topicMap.set(entry.topic.id, {
      ...entry.topic,
      isCustom: true,
      addedAt: entry.addedAt || null,
    });
    questionsByTopic.set(entry.topic.id, entry.questions);
  }

  const topics = [...topicMap.values()].sort((a, b) => {
    if (a.sectionNumber !== null && b.sectionNumber !== null) {
      return a.sectionNumber - b.sectionNumber;
    }
    if (a.sectionNumber !== null) return -1;
    if (b.sectionNumber !== null) return 1;
    return a.title.localeCompare(b.title, 'ru');
  });

  const questions = [];
  for (const t of topics) {
    questions.push(...(questionsByTopic.get(t.id) || []));
  }

  return {
    generatedAt: base.generatedAt,
    updatedAt: new Date().toISOString(),
    totalTopics: topics.length,
    totalQuestions: questions.length,
    topics,
    questions,
  };
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'local';
}

function buildCookieHeader(value, maxAgeSec, req) {
  const isHttps =
    req.headers?.['x-forwarded-proto'] === 'https' || Boolean(req.socket?.encrypted);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

export function createRequestHandler(options = {}) {
  const customTopicsPath = options.customTopicsPath || CUSTOM_TOPICS_PATH;

  return async function handleRequest(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const urlPath = (req.url || '/').split('?')[0];

    // --- API Routes ---
    if (urlPath === '/api/dataset' && method === 'GET') {
      try {
        const dataset = buildMergedDataset(customTopicsPath);
        return sendJson(res, 200, dataset);
      } catch (err) {
        return sendJson(res, 500, { error: 'Не удалось загрузить базу вопросов' });
      }
    }

    if (urlPath === '/api/admin/status' && method === 'GET') {
      const passwordConfigured = Boolean(getAdminPassword());
      return sendJson(res, 200, {
        authenticated: isAdminAuthenticated(req),
        passwordConfigured,
      });
    }

    if (urlPath === '/api/admin/login' && method === 'POST') {
      if (!getAdminPassword()) {
        return sendJson(res, 503, {
          error: 'Вход администратора отключён. Сначала задайте ADMIN_PASSWORD на сервере.',
        });
      }

      const ip = getClientIp(req);
      const limit = checkRateLimit(ip);
      if (!limit.allowed) {
        return sendJson(res, 429, {
          error: `Слишком много неверных попыток. Повторите через ${limit.retryAfterSec} сек.`,
        });
      }

      try {
        const body = await readJsonBody(req);
        if (!verifyPassword(body.password)) {
          recordLoginFailure(ip);
          return sendJson(res, 401, { error: 'Неверный пароль администратора' });
        }
        clearLoginFailures(ip);
        const token = signSessionToken();
        return sendJson(
          res,
          200,
          { authenticated: true },
          { 'Set-Cookie': buildCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000), req) }
        );
      } catch (err) {
        return sendJson(res, 400, { error: 'Некорректный запрос' });
      }
    }

    if (urlPath === '/api/admin/logout' && method === 'POST') {
      return sendJson(
        res,
        200,
        { authenticated: false },
        { 'Set-Cookie': buildCookieHeader('', 0, req) }
      );
    }

    if (urlPath === '/api/admin/import-html' && method === 'POST') {
      if (!isAdminAuthenticated(req)) {
        return sendJson(res, 401, { error: 'Требуются права администратора' });
      }

      try {
        const body = await readJsonBody(req);
        const files = Array.isArray(body.files) ? body.files : [];
        if (files.length === 0) {
          return sendJson(res, 400, { error: 'Файлы не переданы' });
        }

        const customEntries = readCustomEntries(customTopicsPath);
        const results = [];

        for (const f of files) {
          const fileName = String(f?.name || 'imported.html');
          const html = String(f?.html || '');
          if (!html.trim()) {
            results.push({ fileName, level: 'error', message: `${fileName}: пустой файл.` });
            continue;
          }

          const dom = parseHtmlDom(html);
          const { topic, questions } = parseSyncShareDocument(dom, { fileName });

          if (topic.isQuizBankList) {
            results.push({
              fileName,
              level: 'warn',
              message: `${fileName}: файл сохранён со страницы списка тестов («Банк вопросов»), а не «Просмотр вопросов». Откройте конкретный тест и сохраните страницу с вопросами.`,
            });
            continue;
          }

          if (questions.length === 0) {
            results.push({
              fileName,
              level: 'error',
              message: `${fileName}: не удалось найти вопросы формата SyncShare (div[id^="q"]).`,
            });
            continue;
          }

          const entry = {
            topic,
            questions,
            addedAt: new Date().toISOString(),
          };
          const idx = customEntries.findIndex((e) => e.topic && e.topic.id === topic.id);
          if (idx >= 0) customEntries[idx] = entry;
          else customEntries.push(entry);

          results.push({
            fileName,
            level: 'ok',
            topicId: topic.id,
            topicTitle: topic.title,
            count: questions.length,
            message: `${fileName}: добавлено ${questions.length} вопр. в раздел «${topic.title}».`,
          });
        }

        writeCustomEntries(customEntries, customTopicsPath);
        const dataset = buildMergedDataset(customTopicsPath);
        return sendJson(res, 200, { results, dataset });
      } catch (err) {
        const status = err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
        return sendJson(res, status, { error: 'Ошибка обработки загруженных HTML-файлов' });
      }
    }

    if (urlPath.startsWith('/api/admin/topics/') && method === 'DELETE') {
      if (!isAdminAuthenticated(req)) {
        return sendJson(res, 401, { error: 'Требуются права администратора' });
      }
      const topicId = decodeURIComponent(urlPath.slice('/api/admin/topics/'.length));
      const customEntries = readCustomEntries(customTopicsPath);
      const nextEntries = customEntries.filter((e) => e.topic && e.topic.id !== topicId);
      if (nextEntries.length === customEntries.length) {
        return sendJson(res, 404, { error: 'Добавленный раздел не найден' });
      }
      writeCustomEntries(nextEntries, customTopicsPath);
      const dataset = buildMergedDataset(customTopicsPath);
      return sendJson(res, 200, { dataset });
    }

    // --- Public Static File Serving ---
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const relPath =
      urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
    const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
    const isAllowed =
      PUBLIC_EXACT.has(normalized) ||
      PUBLIC_PREFIXES.some((prefix) => normalized.startsWith(prefix));

    if (!isAllowed || normalized.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const fullPath = path.join(__dirname, normalized);
    if (!fullPath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(fullPath).pipe(res);
    });
  };
}

export const handleRequest = createRequestHandler();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`ОЦГ Тренажёр запущен: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
    if (!getAdminPassword()) {
      console.warn('[ВНИМАНИЕ] ADMIN_PASSWORD не задан. Публичный тренажёр доступен, вход администратора отключён.');
    }
  });
}
