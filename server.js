/**
 * Social Video Downloader — backend (Node.js + Express + yt-dlp)
 *
 * Kaam kaise karta hai:
 *  1. Frontend /api/info par link bhejta hai -> yt-dlp se video ki details
 *     (title, thumbnail, duration, available qualities) milti hain.
 *  2. User quality chunta hai -> /api/download video ko server par
 *     download karke browser ko file bhej deta hai.
 *
 * Zaroori cheezein (server par install honi chahiye):
 *  - Node.js 18+
 *  - yt-dlp  (https://github.com/yt-dlp/yt-dlp)
 *  - ffmpeg  (video+audio merge karne ke liye)
 *
 * Optional: login wali / private videos ke liye browser se export ki hui
 * cookies.txt isi folder mein rakhein — server khud use kar lega.
 */

const express = require('express');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

function baseArgs() {
  // --concurrent-fragments: DASH video (YouTube waghera) ke tukde ek saath
  // download karta hai — download kaafi tez ho jata hai.
  const args = ['--no-playlist', '--no-warnings', '--socket-timeout', '30', '--retries', '2', '--concurrent-fragments', '8'];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  return args;
}

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeName(name) {
  return (name || 'video').replace(/[^\w\-. ]+/g, '_').slice(0, 120).trim() || 'video';
}

// Quality -> yt-dlp format selector
const FORMATS = {
  best:  'bv*+ba/b',
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720':  'bv*[height<=720]+ba/b[height<=720]',
  '480':  'bv*[height<=480]+ba/b[height<=480]',
  '360':  'bv*[height<=360]+ba/b[height<=360]',
  audio: 'ba/b',
};

/** POST /api/info  { url } -> video details + available qualities */
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Sahi link paste karein (http/https).' });
  }

  execFile(
    'yt-dlp',
    [...baseArgs(), '-J', url],
    { maxBuffer: 20 * 1024 * 1024, timeout: 60000 },
    (err, stdout) => {
      if (err) {
        console.error(err.message);
        return res.status(400).json({
          error: 'Video ki details nahi mil sakin. Link public hona chahiye — private / login wali video ke liye cookies.txt chahiye.',
        });
      }
      let info;
      try {
        info = JSON.parse(stdout);
      } catch {
        return res.status(500).json({ error: 'Video details samajh nahi aayi.' });
      }

      // Kaunsi qualities available hain, formats se nikalein
      const heights = new Set();
      (info.formats || []).forEach((f) => {
        if (f.vcodec && f.vcodec !== 'none' && f.height) heights.add(f.height);
      });
      const qualities = ['best'];
      ['1080', '720', '480', '360'].forEach((h) => {
        if ([...heights].some((x) => x >= parseInt(h, 10))) qualities.push(h);
      });
      qualities.push('audio');

      const thumb = (info.thumbnails || []).slice(-1)[0]?.url || info.thumbnail || '';

      res.json({
        title: info.title || 'Video',
        uploader: info.uploader || info.channel || '',
        duration: info.duration || 0,
        thumbnail: thumb,
        isImage: /\.(jpe?g|png|webp|gif)$/i.test(url),
        qualities,
      });
    }
  );
});

/** GET /api/download?url=...&quality=720  -> file download
 *  FAST tareeqa: yt-dlp video ko seedha stdout par bhejta hai aur server
 *  usay foran phone/browser ko stream kar deta hai. Pehle poori file
 *  server par download hone ka intezar NAHI karna padta — download
 *  shuru hote hi aap ke phone par aana shuru ho jata hai. */
app.get('/api/download', (req, res) => {
  const { url, quality = 'best' } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).send('Sahi link paste karein.');
  }
  const selector = FORMATS[quality] || FORMATS.best;
  const isAudio = quality === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const downloadName = `VidUthao-${isAudio ? 'audio' : 'video'}.${ext}`;

  const args = [
    ...baseArgs(),
    '-f', selector,
    '--merge-output-format', 'mp4',
    ...(isAudio ? ['--extract-audio', '--audio-format', 'mp3'] : []),
    '-o', '-', // stdout par bhejo — seedha stream hoga
    url,
  ];

  const child = spawn('yt-dlp', args, { timeout: 300000 });
  let stderr = '';
  let started = false;
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.once('data', () => {
    started = true;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
  });
  child.stdout.pipe(res);
  child.on('error', () => {
    if (!started) res.status(500).send('yt-dlp nahi mila. Server par yt-dlp install karein.');
    else res.end();
  });
  child.on('close', (code) => {
    if (code !== 0 && !started) {
      console.error(stderr);
      res.status(400).send('Download nahi ho saka. Link public hona chahiye — private / login wali video ke liye cookies.txt chahiye.');
    } else if (code !== 0) {
      res.end();
    }
  });
});

app.listen(PORT, () => {
  console.log(`Social Video Downloader chal raha hai: http://localhost:${PORT}`);
});
