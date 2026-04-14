/**
 * EgorNetwork YouTube Downloader Backend
 * Backend для скачивания видео с YouTube
 * https://egornetwork.ru/youtube.html
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔧 Путь к yt-dlp (приоритет: глобальный > локальный > системный)
const YT_DLP_BIN = 
  process.env.YT_DLP_PATH || 
  (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// 🛡️ Middleware
app.use(cors({
  origin: ['https://egornetwork.ru', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// 🚦 Rate limiting (защита от спама)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: process.env.NODE_ENV === 'production' ? 20 : 100, // лимит запросов
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// 📦 Параметры форматов для yt-dlp
function getFormatParams(mode) {
  switch (mode) {
    case 'audio':
      return { 
        format: 'bestaudio[ext=m4a]/bestaudio/best[ext=m4a]/best', 
        ext: 'm4a', 
        mimeType: 'audio/mp4' 
      };
    case 'video_max':
      return { 
        format: 'bv+ba/b[height<=2160]/best', 
        ext: 'mp4', 
        mimeType: 'video/mp4' 
      };
    default: // video (до 1080p)
      return { 
        format: 'bv[height<=1080]+ba/b[height<=1080]/best[height<=1080]/best', 
        ext: 'mp4', 
        mimeType: 'video/mp4' 
      };
  }
}

// 🎭 Эмуляция разных клиентских профилей для обхода бот-детекта
function getClientEmulationArgs() {
  return [
    // Пробуем разные клиентские профили (fallback)
    '--extractor-args', 'youtube:player-client=ios,web,android,mweb',
    // Заголовки, чтобы выглядеть как обычный браузер
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--add-header', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    '--add-header', 'Accept-Language: en-US,en;q=0.9,ru;q=0.8',
    // Отключаем некоторые фичи, которые могут триггерить защиту
    '--no-check-certificates',
    '--socket-timeout', '15'
  ];
}

// 🔍 Получение метаданных видео (без скачивания)
function ytDlpJson(url) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '15',
      ...getClientEmulationArgs()
    ];

    console.log(`[yt-dlp info] Spawning: ${YT_DLP_BIN} ${args.join(' ')}`);
    
    const proc = spawn(YT_DLP_BIN, args, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8' }
    });
    
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { 
      const chunk = c.toString();
      err += chunk;
      // Логируем только важные ошибки, не весь вывод
      if (chunk.includes('ERROR') || chunk.includes('WARNING')) {
        console.error(`[yt-dlp stderr] ${chunk.trim()}`);
      }
    });
    
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        const errorMsg = err.trim() || `yt-dlp exited with code ${code}`;
        // Проверяем на специфичные ошибки
        if (errorMsg.includes('Sign in to confirm')) {
          return reject(new Error('BOT_PROTECTED'));
        }
        if (errorMsg.includes('private video') || errorMsg.includes('This video is private')) {
          return reject(new Error('PRIVATE_VIDEO'));
        }
        if (errorMsg.includes('Video unavailable')) {
          return reject(new Error('VIDEO_UNAVAILABLE'));
        }
        return reject(new Error(errorMsg));
      }
      try { 
        const json = JSON.parse(out);
        resolve(json); 
      } catch (e) { 
        reject(new Error('Failed to parse yt-dlp JSON response')); 
      }
    });
  });
}

// 📥 Endpoint: получение информации о видео
app.get('/api/info', async (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({ error: 'Параметр "url" обязателен' });
  }
  
  // Валидация: только youtube/youtu.be
  if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(url)) {
    return res.status(400).json({ error: 'Неподдерживаемый домен. Только YouTube.' });
  }
  
  try {
    console.log(`[info] Request for: ${url}`);
    const info = await ytDlpJson(url);
    
    // Возвращаем только нужные поля (без лишних данных)
    res.json({
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      view_count: info.view_count,
      upload_date: info.upload_date,
      description: info.description?.slice(0, 500) + '...', // Обрезаем длинное описание
      formats_count: info.formats?.length || 0
    });
  } catch (err) {
    console.error(`[info] Error: ${err.message}`);
    
    const errorMap = {
      'BOT_PROTECTED': 'YouTube требует подтверждения. Попробуйте позже или используйте другое видео.',
      'PRIVATE_VIDEO': 'Это видео приватное или удалено.',
      'VIDEO_UNAVAILABLE': 'Видео недоступно в вашем регионе или удалено.',
      'DEFAULT': 'Не удалось получить информацию о видео. Проверьте ссылку.'
    };
    
    const errorMsg = errorMap[err.message] || errorMap['DEFAULT'];
    res.status(500).json({ error: errorMsg, debug: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
});

// ⬇️ Endpoint: скачивание видео
app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  const mode = req.query.mode || 'video'; // video | video_max | audio
  
  if (!url) {
    return res.status(400).json({ error: 'Параметр "url" обязателен' });
  }
  
  // Валидация домена
  if (!/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(url)) {
    return res.status(400).json({ error: 'Неподдерживаемый домен. Только YouTube.' });
  }
  
  const { format, ext, mimeType } = getFormatParams(mode);
  
  console.log(`[download] Request: ${url} | mode: ${mode} | format: ${format}`);
  
  // Заголовки для скачивания
  res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Аргументы для yt-dlp
  const args = [
    url,
    '-f', format,
    '--no-playlist',
    '-o', '-', // Вывод в stdout
    '--no-warnings',
    '--socket-timeout', '15',
    '--retries', '3',
    '--fragment-retries', '3',
    ...getClientEmulationArgs()
  ];
  
  // Запускаем yt-dlp
  const ytProcess = spawn(YT_DLP_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'en_US.UTF-8' }
  });
  
  let hasError = false;
  
  // Обработка ошибок из stderr
  ytProcess.stderr.on('data', (chunk) => {
    const msg = chunk.toString();
    if (msg.includes('ERROR')) {
      console.error(`[yt-dlp] ERROR: ${msg.trim()}`);
      if (!hasError && !res.headersSent) {
        hasError = true;
        if (msg.includes('Sign in to confirm')) {
          res.status(503).json({ error: 'YouTube требует подтверждения. Попробуйте позже.' });
        } else if (msg.includes('Requested format is not available')) {
          res.status(400).json({ error: 'Запрошенный формат недоступен. Попробуйте другой режим качества.' });
        } else {
          res.status(500).json({ error: 'Ошибка при обработке видео. Попробуйте позже.' });
        }
      }
    }
  });
  
  // Пайпим stdout (видеопоток) в ответ
  ytProcess.stdout.on('data', (chunk) => {
    if (!hasError && !res.headersSent) {
      // Убедимся, что заголовки отправлены только один раз
      if (!res.headersSent) {
        // Заголовки уже установлены выше, просто пишем данные
      }
      res.write(chunk);
    }
  });
  
  // Обработка завершения процесса
  ytProcess.on('close', (code) => {
    if (code !== 0 && !hasError && !res.headersSent) {
      console.error(`[yt-dlp] Process exited with code ${code}`);
      res.status(500).json({ error: 'Не удалось завершить скачивание. Попробуйте позже.' });
    } else if (!hasError && !res.headersSent) {
      // Успешное завершение — закрываем поток
      res.end();
      console.log(`[download] Completed: ${url}`);
    }
  });
  
  // Обработка ошибок spawn
  ytProcess.on('error', (err) => {
    console.error(`[yt-dlp] Spawn error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Сервер не может обработать запрос. Попробуйте позже.' });
    }
  });
  
  // Обработка разрыва соединения клиентом
  req.on('close', () => {
    if (!ytProcess.killed) {
      ytProcess.kill('SIGTERM');
      console.log(`[download] Client disconnected, killed yt-dlp for: ${url}`);
    }
  });
});

// 🏠 Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'EgorNetwork YouTube Downloader',
    version: '1.1.0',
    timestamp: new Date().toISOString()
  });
});

// 🚀 Запуск сервера
app.listen(PORT, () => {
  console.log(`🎮 EgorNetwork Backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   yt-dlp binary: ${YT_DLP_BIN}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;
