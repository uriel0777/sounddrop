const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const ffmpegStatic = require('ffmpeg-static');
// yt-dlp expects the directory containing ffmpeg, not the full executable path
const ffmpegDir = path.dirname(ffmpegStatic);

const isWindows = process.platform === 'win32';
const ytDlpName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const ytDlpPath = path.join(__dirname, ytDlpName);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Utility: follow redirects and download a file ────────────────────────────
function downloadFileTo(url, dest) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl) {
      const proto = currentUrl.startsWith('https') ? https : http;
      proto.get(currentUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          const next = location.startsWith('http')
            ? location
            : new URL(location, currentUrl).toString();
          attempt(next);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
      }).on('error', reject);
    }
    attempt(url);
  });
}

// ─── Ensure yt-dlp binary exists (downloads on first run) ─────────────────────
async function ensureYtDlp() {
  if (fs.existsSync(ytDlpPath)) {
    console.log('✅  yt-dlp already present');
    return;
  }
  console.log(`⬇️  yt-dlp not found — downloading from GitHub for ${process.platform}...`);
  const url = isWindows
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    
  await downloadFileTo(url, ytDlpPath);
  
  if (!isWindows) {
    fs.chmodSync(ytDlpPath, 0o755); // Make executable on Linux
  }
  console.log('✅  yt-dlp downloaded successfully');
}

// ─── Setup Cookies ───────────────────────────────────────────────────────────
// We previously used cookies to bypass 429 errors, but it triggers PoToken JS errors.
// Now using native ios/android fallback clients (bypasses bot checks anonymously).
const cookiesPath = path.join(__dirname, 'cookies.txt');

// ─── Utility: format seconds → mm:ss or h:mm:ss ──────────────────────────────
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── GET /api/search?q=<query> ─────────────────────────────────────────────────
// Uses yt-dlp's built-in ytsearch — most reliable since yt-dlp is actively maintained
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Query is required' });

  const args = [
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--skip-download',
    `ytsearch12:${query}`,
  ];

  const proc = spawn(ytDlpPath, args);
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0 && !stdout.trim()) {
      console.error('yt-dlp search stderr:', stderr);
      return res.status(500).json({ error: 'Search failed. Please try again.' });
    }

    try {
      const videos = stdout
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => {
          const v = JSON.parse(line);
          return {
            id: v.id,
            title: v.title || 'Unknown Title',
            channel: v.channel || v.uploader || 'Unknown Channel',
            duration: formatDuration(v.duration),
            thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
            views: v.view_count ? Number(v.view_count).toLocaleString() : null,
            uploadedAt: v.upload_date
              ? `${v.upload_date.slice(0,4)}-${v.upload_date.slice(4,6)}-${v.upload_date.slice(6,8)}`
              : null,
            url: `https://www.youtube.com/watch?v=${v.id}`,
          };
        })
        .filter((v) => v.id && v.id.length === 11); // video IDs are always 11 chars

      res.json({ results: videos });
    } catch (err) {
      console.error('Parse error:', err.message);
      res.status(500).json({ error: 'Failed to parse search results.' });
    }
  });

  proc.on('error', (err) => {
    console.error('yt-dlp spawn error:', err);
    res.status(500).json({ error: 'Could not start yt-dlp.' });
  });
});

// ─── GET /api/download?videoId=<id>&format=<mp3|mp4>&title=<title> ─────────────
app.get('/api/download', (req, res) => {
  const { videoId, format, title } = req.query;

  if (!videoId || !format) {
    return res.status(400).json({ error: 'videoId and format are required' });
  }
  if (!['mp3', 'mp4'].includes(format)) {
    return res.status(400).json({ error: 'format must be mp3 or mp4' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Sanitise filename — keep letters, digits, spaces, dashes, parentheses
  const safeTitle = (title || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .substring(0, 120) || 'download';

  let args;
  let filename;
  let contentType;

    args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegDir,
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=ios,android',
    ];
  } else {
    filename = `${safeTitle}.mp4`;
    contentType = 'video/mp4';
    args = [
      '-f', 'b', // 'b' (best pre-merged) strictly falls back to format 18, which bypasses PoToken on ios/android
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegDir,
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=ios,android',
    ];
  }

  args.push('-o', '-', videoUrl);

  console.log(`⬇️  Downloading [${format.toUpperCase()}]: ${safeTitle}`);

  let ytDlp;
  try {
    ytDlp = spawn(ytDlpPath, args);
  } catch (startErr) {
    console.error('yt-dlp sync spawn error:', startErr);
    return res.status(500).json({ error: 'Download process failed to start' });
  }

  let hasSentHeaders = false;
  let errorLog = '';

  ytDlp.stdout.on('data', (chunk) => {
    if (!hasSentHeaders) {
      if (!res.headersSent) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Filename', encodeURIComponent(filename));
      }
      hasSentHeaders = true;
    }
    res.write(chunk);
  });

  ytDlp.stdout.on('end', () => {
    if (hasSentHeaders) {
      res.end();
    }
  });

  ytDlp.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`[yt-dlp] ${line}`);
      if (line.toLowerCase().includes('error')) {
        errorLog += line + ' ';
      }
    }
  });

  ytDlp.on('error', (err) => {
    console.error('yt-dlp async spawn error:', err);
    if (!hasSentHeaders && !res.headersSent) {
      res.status(500).json({ error: 'Process error: ' + err.message });
      hasSentHeaders = true;
    }
  });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.warn(`yt-dlp exited with code ${code}`);
      if (!hasSentHeaders && !res.headersSent) {
        const errorMsg = errorLog ? errorLog : 'YouTube rejected the request or stream failed.';
        res.status(500).json({ error: errorMsg });
        hasSentHeaders = true;
      }
    } else {
      console.log(`✅  Done: ${filename}`);
      if (!hasSentHeaders && !res.headersSent) {
        res.end();
      }
    }
  });

  // Kill yt-dlp if client disconnects
  req.on('close', () => {
    if (ytDlp.pid && ytDlp.exitCode === null) {
      ytDlp.kill('SIGTERM');
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await ensureYtDlp();
  } catch (err) {
    console.error('⚠️  Could not download yt-dlp automatically:', err.message);
    console.error('   Please download yt-dlp.exe manually from https://github.com/yt-dlp/yt-dlp/releases');
    console.error('   and place it next to server.js');
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║  🎵  YouTube Downloader  •  Running    ║');
    console.log(`║  ➜  http://localhost:${PORT}             ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
  });
}

start().catch(console.error);
