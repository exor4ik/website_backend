'use strict';

const express   = require('express');
const cors      = require('cors');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');

const {
  startCookieRefresh,
  getCookiesFile,
  getRefreshStatus,
  refreshCookies,
} = require('./cookies-refresh');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const YT_DLP_BIN = 'yt-dlp';

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

app.use(express.json());

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите минуту.' },
}));

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────

function isValidYouTubeUrl(url) {
  return /^https?:\/\/(?:www\.)?(youtube\.com|youtu\.?be)\/.+/.test(url);
}

function safeFilename(title = 'video', ext) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 100) + '.' + ext;
}

function getFormatParams(mode) {
  switch (mode) {
    case 'audio':
      return { format: 'bestaudio[ext=m4a]/bestaudio', ext: 'm4a', mimeType: 'audio/mp4' };
    case 'video_max':
      return { format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', ext: 'mp4', mimeType: 'video/mp4' };
    default:
      return { format: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', ext: 'mp4', mimeType: 'video/mp4' };
  }
}

function cookiesArgs() {
  const f = getCookiesFile();
  return f ? ['--cookies', f] : [];
}

function ytDlpJson(url) {
  return new Promise((resolve, reject) => {
    const args = [url, '--dump-single-json', '--no-warnings', '--no-playlist', '--skip-download', ...cookiesArgs()];
    const proc = spawn(YT_DLP_BIN, args);
    let out = '', err = '';

    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('Не удалось разобрать ответ yt-dlp')); }
    });
  });
}

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: Date.now(),
    uptime:    Math.floor(process.uptime()),
    cookies:   getRefreshStatus(),
  });
});

// ─────────────────────────────────────────────
// POST /api/cookies/refresh  — ручной запуск обновления
// Защищён простым токеном
// ─────────────────────────────────────────────

app.post('/api/cookies/refresh', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const ok = await refreshCookies();
  res.json({ ok, status: getRefreshStatus() });
});

// ─────────────────────────────────────────────
// POST /api/info
// ─────────────────────────────────────────────

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url)                    return res.status(400).json({ error: 'URL обязателен' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Некорректный YouTube URL' });

  try {
    const info = await ytDlpJson(url);
    res.json({ title: info.title, duration: info.duration, thumbnail: info.thumbnail });
  } catch (err) {
    console.error('[info]', err.message);
    res.status(400).json({ error: 'Не удалось получить информацию о видео' });
  }
});

// ─────────────────────────────────────────────
// GET /api/download
// ─────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url: rawUrl, mode = 'video' } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'URL обязателен' });

  const url = decodeURIComponent(rawUrl);
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Некорректный YouTube URL' });

  const { format, ext, mimeType } = getFormatParams(mode);

  try {
    const info     = await ytDlpJson(url);
    const filename = safeFilename(info.title, ext);

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Transfer-Encoding', 'chunked');

    const ytProcess = spawn(YT_DLP_BIN, [
      url, '-f', format, '--no-playlist', '--no-warnings', '-o', '-', ...cookiesArgs(),
    ]);

    ytProcess.stdout.pipe(res);
    ytProcess.stderr.on('data', c => { const l = c.toString().trim(); if (l) console.log('[yt-dlp]', l); });
    ytProcess.on('error', err => {
      console.error('[yt-dlp error]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка при скачивании' });
    });
    req.on('close', () => ytProcess.kill('SIGTERM'));

  } catch (err) {
    console.error('[download]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

async function main() {
  // Запускаем обновление cookies до старта сервера
  await startCookieRefresh();

  app.listen(PORT, () => {
    console.log(`✅ Backend на порту ${PORT}`);
    console.log(`   Cookies: ${getRefreshStatus().cookiesExist ? '✅ есть' : '❌ нет'}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
