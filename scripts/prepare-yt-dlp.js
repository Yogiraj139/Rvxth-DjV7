import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';

function getDownloadName() {
  if (process.platform === 'win32') {
    return 'yt-dlp.exe';
  }

  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'yt-dlp_linux_aarch64';
  }

  if (process.platform === 'linux') {
    return 'yt-dlp_linux';
  }

  if (process.platform === 'darwin') {
    return 'yt-dlp_macos';
  }

  return 'yt-dlp';
}

const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const downloadName = getDownloadName();
const binDir = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin');
const binPath = path.join(binDir, binName);
const downloadUrl =
  process.env.YTDLP_DOWNLOAD_URL ||
  `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${downloadName}`;

function firstBytes(filePath) {
  try {
    const handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  }
}

function looksBroken(filePath) {
  if (!fs.existsSync(filePath)) {
    return true;
  }

  const stats = fs.statSync(filePath);
  if (stats.size < 100_000) {
    return true;
  }

  const head = firstBytes(filePath).toLowerCase();
  return (
    (process.platform === 'linux' && head.includes('/usr/bin/env python')) ||
    head.includes('<!doctype') ||
    head.includes('<html') ||
    head.includes('<?xml') ||
    head.includes('rate limit') ||
    head.includes('not found')
  );
}

function request(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'user-agent': 'rvxth-dj-yt-dlp-installer'
        }
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          res.headers.location &&
          redirectCount < 5
        ) {
          res.resume();
          resolve(request(new URL(res.headers.location, url).toString(), redirectCount + 1));
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${statusCode}`));
          return;
        }

        resolve(res);
      }
    );

    req.setTimeout(60_000, () => {
      req.destroy(new Error('Download timed out'));
    });

    req.once('error', reject);
  });
}

async function downloadFile(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.download`;
  const response = await request(url);
  const file = fs.createWriteStream(tempPath, { mode: 0o755 });

  await new Promise((resolve, reject) => {
    response.pipe(file);
    response.once('error', reject);
    file.once('error', reject);
    file.once('finish', resolve);
  });

  file.close();

  if (looksBroken(tempPath)) {
    fs.rmSync(tempPath, { force: true });
    throw new Error('Downloaded yt-dlp file looks invalid.');
  }

  fs.renameSync(tempPath, destination);

  if (process.platform !== 'win32') {
    fs.chmodSync(destination, 0o755);
  }
}

if (looksBroken(binPath) || process.platform === 'linux') {
  console.log(`Preparing yt-dlp from ${downloadUrl}`);
  await downloadFile(downloadUrl, binPath);
  console.log(`yt-dlp ready at ${binPath}`);
} else {
  console.log(`yt-dlp already looks valid at ${binPath}`);
}
