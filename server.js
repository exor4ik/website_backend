'use strict';

/**
 * 🎬 YouTube Downloader — Backend
 * Express + yt-dlp, деплой на Render.com
 */

const express    = require('express');
const cors       = require('cors');
const { spawn }  = require('child_process');
const ytDlp      = require('yt-dlp-exec');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Путь к бинарнику yt-dlp (скачивается автоматически через npm install)
const YT_DLP_BIN = path.join(
  path.dirname(require.resolve('yt-dlp-exec/package.json')),
  'bin',
  'yt-dlp'
);

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Rate limit: 10 запросов в минуту с одного IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите минуту.' },
}));

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

function isValidYouTubeUrl(url) {
  return /^https?:\/\/(?:www\.)?(youtube\.com|youtu\.?be)\/.+/.test(url);
}

function safeFilename(title = 'video', ext) {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .trim()
      .slice(0, 100) + '.' + ext
  );
}

function getFormatParams(mode) {
  switch (mode) {
    case 'audio':
      return {
        format:   'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        ext:      'm4a',
        mimeType: 'audio/mp4',
      };
    case 'video_max':
      return {
        format:   'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
        ext:      'mp4',
        mimeType: 'video/mp4',
      };
    default: // 'video'
      return {
        format:   'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[ext=mp4]/best',
        ext:      'mp4',
        mimeType: 'video/mp4',
      };
  }
}

// ─────────────────────────────────────────────
// GET /health  — пробуждение сервера
// Фронтенд пингует этот эндпоинт пока Render не поднимется
// ─────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: Date.now(),
    uptime:    Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// POST /api/info  — информация о видео
// ─────────────────────────────────────────────

app.post('/api/info', async (req, res) => {
  const { url } = req.body;

  if (!url)                    return res.status(400).json({ error: 'URL обязателен' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Некорректный YouTube URL' });

  try {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings:     true,
      noPlaylist:     true,
      skipDownload:   true,
    });

    res.json({
      title:      info.title,
      duration:   info.duration,
      thumbnail:  info.thumbnail,
      uploader:   info.uploader,
      view_count: info.view_count,
    });
  } catch (err) {
    console.error('[info]', err.message);
    res.status(400).json({ error: 'Не удалось получить информацию о видео' });
  }
});

// ─────────────────────────────────────────────
// GET /api/download  — стриминг файла
// ?url=<encoded>&mode=video|audio|video_max
// ─────────────────────────────────────────────

app.get('/api/download', async (req, res) => {
  const { url: rawUrl, mode = 'video' } = req.query;

  if (!rawUrl) return res.status(400).json({ error: 'URL обязателен' });

  const url = decodeURIComponent(rawUrl);

  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Некорректный YouTube URL' });

  const { format, ext, mimeType } = getFormatParams(mode);

  try {
    // 1. Получаем название для имени файла
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings:     true,
      noPlaylist:     true,
      skipDownload:   true,
    });

    const filename = safeFilename(info.title, ext);

    // 2. Заголовки ответа
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Transfer-Encoding', 'chunked');

    // 3. Запускаем yt-dlp и пайпим stdout → response
    const ytProcess = spawn(YT_DLP_BIN, [
      url,
      '-f', format,
      '--no-playlist',
      '--no-warnings',
      '-o', '-',          // вывод в stdout
    ]);

    ytProcess.stdout.pipe(res);

    ytProcess.stderr.on('data', (chunk) => {
      // Логируем прогресс yt-dlp (видно в логах Render)
      const line = chunk.toString().trim();
      if (line) console.log('[yt-dlp]', line);
    });

    ytProcess.on('error', (err) => {
      console.error('[yt-dlp error]', err);
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка при скачивании' });
    });

    ytProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[yt-dlp] завершился с кодом ${code}`);
      }
    });

    // Клиент отключился — убиваем процесс чтобы не тратить ресурсы
    req.on('close', () => ytProcess.kill('SIGTERM'));

  } catch (err) {
    console.error('[download]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Backend запущен на порту ${PORT}`);
  console.log(`   yt-dlp: ${YT_DLP_BIN}`);
});
