/**
 * EgorNetwork YouTube Downloader Backend
 * https://egornetwork.ru/youtube.html
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Render стоит за прокси — нужно для rate-limit
app.set('trust proxy', 1);

// ─────────────────────────────────────────────
// yt-dlp бинарник
// ─────────────────────────────────────────────

const YT_DLP_BIN = process.env.YT_DLP_PATH ||
  (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// ─────────────────────────────────────────────
// Cookies — загружаем из env при старте
// ─────────────────────────────────────────────

const COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');

function loadCookies() {
  const raw = process.env.YT_COOKIES;
  if (!raw || !raw.trim()) {
    console.warn('⚠️  YT_COOKIES не задан — возможна блокировка YouTube');
    return false;
  }
  try {
    fs.writeFileSync(COOKIES_FILE, raw, 'utf8');
    console.log(`✅ Cookies загружены (${raw.split('\n').length} строк)`);
    return true;
  } catch (e) {
    console.error('❌ Не удалось записать cookies:', e.message);
    return false;
  }
}

loadCookies();

function cookiesArgs() {
  try {
    if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 0) {
      return ['--cookies', COOKIES_FILE];
    }
  } catch (_) {}
  return [];
}

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(cors({
  origin: ['https://egornetwork.ru', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 100,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────

function getFormatParams(mode) {
  switch (mode) {
    case 'audio':
      return { format: 'bestaudio[ext=m4a]/bestaudio/best', ext: 'm4a', mimeType: 'audio/mp4' };
    case 'video_max':
      return { format: 'bv+ba/b[height<=2160]/best', ext: 'mp4', mimeType: 'video/mp4' };
    default:
      return { format: 'bv[height<=1080]+ba/b[height<=1080]/best[height<=1080]/best', ext: 'mp4', mimeType: 'video/mp4' };
  }
}

function getClientArgs() {
  return [
    '--extractor-args', 'youtube:player-client=ios,web,android,mweb',
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language: en-US,en;q=0.9,ru;q=0.8',
    '--no-check-certificates',
    '--socket-timeout', '15',
  ];
}

function isValidYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(url);
}

function ytDlpJson(url) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '15',
      ...cookiesArgs(),
      ...getClientArgs(),
    ];

    const proc = spawn(YT_DLP_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8' },
    });

    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => {
      const s = c.toString();
      err += s;
      if (s.includes('ERROR') || s.includes('WARNING')) {
        console.error('[yt-dlp stderr]', s.trim());
      }
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        const msg = err.trim() || `yt-dlp exited ${code}`;
        if (msg.includes('Sign in to confirm'))   return reject(new Error('BOT_PROTECTED'));
        if (msg.includes('private video'))         return reject(new Error('PRIVATE_VIDEO'));
        if (msg.includes('Video unavailable'))     return reject(new Error('VIDEO_UNAVAILABLE'));
        return reject(new Error(msg));
      }
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('Failed to parse yt-dlp JSON')); }
    });
  });
}

const ERROR_MAP = {
  BOT_PROTECTED:    'YouTube требует подтверждения. Попробуйте позже или обновите cookies.',
  PRIVATE_VIDEO:    'Это видео приватное или удалено.',
  VIDEO_UNAVAILABLE:'Видео недоступно в вашем регионе или удалено.',
  DEFAULT:          'Не удалось получить информацию о видео. Проверьте ссылку.',
};

// ─────────────────────────────────────────────
// GET /health  (wake-up пинг с фронтенда)
// GET /api/health
// ─────────────────────────────────────────────

function healthResponse(req, res) {
  res.json({
    status:      'ok',
    service:     'EgorNetwork YouTube Downloader',
    version:     '1.2.0',
    timestamp:   new Date().toISOString(),
    cookies_set: fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 0,
  });
}

app.get('/health',     healthResponse);
app.get('/api/health', healthResponse);

// ─────────────────────────────────────────────
// GET /api/info
// ─────────────────────────────────────────────

app.get('/api/info', async (req, res) => {
  const url = req.query.url;
  if (!url)                    return res.status(400).json({ error: 'Параметр "url" обязателен' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Неподдерживаемый домен. Только YouTube.' });

  try {
    console.log(`[info] ${url}`);
    const info = await ytDlpJson(url);
    res.json({
      id:            info.id,
      title:         info.title,
      duration:      info.duration,
      thumbnail:     info.thumbnail,
      uploader:      info.uploader,
      view_count:    info.view_count,
      upload_date:   info.upload_date,
      description:   info.description?.slice(0, 500),
      formats_count: info.formats?.length || 0,
    });
  } catch (err) {
    console.error('[info] Error:', err.message);
    res.status(500).json({ error: ERROR_MAP[err.message] || ERROR_MAP.DEFAULT });
  }
});

// ─────────────────────────────────────────────
// GET /api/download
// ─────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const url  = req.query.url;
  const mode = req.query.mode || 'video';

  if (!url)                    return res.status(400).json({ error: 'Параметр "url" обязателен' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Неподдерживаемый домен. Только YouTube.' });

  const { format, ext, mimeType } = getFormatParams(mode);
  console.log(`[download] ${url} | mode: ${mode} | format: ${format}`);

  res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const args = [
    url,
    '-f', format,
    '--no-playlist',
    '--no-warnings',
    '-o', '-',
    '--socket-timeout', '15',
    '--retries', '3',
    '--fragment-retries', '3',
    ...cookiesArgs(),
    ...getClientArgs(),
  ];

  const ytProcess = spawn(YT_DLP_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'en_US.UTF-8' },
  });

  let hasError = false;

  ytProcess.stdout.on('data', chunk => {
    if (!hasError) res.write(chunk);
  });

  ytProcess.stderr.on('data', chunk => {
    const msg = chunk.toString();
    if (!msg.includes('ERROR')) return;
    console.error('[yt-dlp]', msg.trim());
    if (hasError || res.headersSent) return;
    hasError = true;
    if (msg.includes('Sign in to confirm')) {
      res.status(503).json({ error: 'YouTube требует подтверждения. Обновите cookies.' });
    } else if (msg.includes('Requested format is not available')) {
      res.status(400).json({ error: 'Формат недоступен. Попробуйте другой режим.' });
    } else {
      res.status(500).json({ error: 'Ошибка при обработке видео.' });
    }
  });

  ytProcess.on('close', code => {
    if (code !== 0 && !hasError && !res.headersSent) {
      console.error(`[yt-dlp] exited with code ${code}`);
      res.status(500).json({ error: 'Не удалось завершить скачивание.' });
    } else if (!hasError) {
      res.end();
      console.log(`[download] Done: ${url}`);
    }
  });

  ytProcess.on('error', err => {
    console.error('[yt-dlp] Spawn error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Сервер не может обработать запрос.' });
  });

  req.on('close', () => {
    if (!ytProcess.killed) ytProcess.kill('SIGTERM');
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🎮 EgorNetwork Backend на порту ${PORT}`);
  console.log(`   yt-dlp: ${YT_DLP_BIN}`);
  console.log(`   Cookies: ${fs.existsSync(COOKIES_FILE) ? '✅' : '❌'}`);
});

process.on('SIGTERM', () => {
  console.log('🔄 Shutting down...');
  process.exit(0);
});
