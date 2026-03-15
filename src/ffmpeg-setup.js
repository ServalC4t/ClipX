/**
 * ffmpeg-setup.js
 * 起動時にFFmpegの存在を確認し、なければ自動ダウンロード・展開する
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// FFmpegのダウンロード先（gyan.dev — Windowsビルド）
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

// インストール先：ユーザーのAppData/Local/ClipX/ffmpeg/
function getFFmpegInstallDir() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ClipX', 'ffmpeg');
}

function getFFmpegExe() {
  return path.join(getFFmpegInstallDir(), 'ffmpeg.exe');
}

function getFFprobeExe() {
  return path.join(getFFmpegInstallDir(), 'ffprobe.exe');
}

/**
 * FFmpegが使える状態かチェック
 * @returns {boolean}
 */
function isFFmpegReady() {
  const ffmpegPath = getFFmpegExe();
  const ffprobePath = getFFprobeExe();

  // まず同梱版をチェック（resourcesPath）
  const bundledFFmpeg = path.join(
    process.resourcesPath || path.join(__dirname, '..'),
    'ffmpeg', 'ffmpeg.exe'
  );
  if (fs.existsSync(bundledFFmpeg)) return true;

  // AppData配下をチェック
  return fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath);
}

/**
 * 実行時に使うFFmpegのパスを返す
 */
function resolveFFmpegPath() {
  const bundled = path.join(
    process.resourcesPath || path.join(__dirname, '..'),
    'ffmpeg', 'ffmpeg.exe'
  );
  if (fs.existsSync(bundled)) return bundled;
  return getFFmpegExe();
}

function resolveFFprobePath() {
  const bundled = path.join(
    process.resourcesPath || path.join(__dirname, '..'),
    'ffmpeg', 'ffprobe.exe'
  );
  if (fs.existsSync(bundled)) return bundled;
  return getFFprobeExe();
}

/**
 * FFmpegをダウンロード・インストールする
 * @param {BrowserWindow} win - 進捗を送るウィンドウ
 * @returns {Promise<void>}
 */
function installFFmpeg(win) {
  return new Promise((resolve, reject) => {
    const installDir = getFFmpegInstallDir();
    const tmpZip = path.join(os.tmpdir(), `ffmpeg_setup_${Date.now()}.zip`);

    // 1. ダウンロード
    sendStatus(win, 'downloading', 0, 'FFmpegをダウンロード中...');

    downloadFile(FFMPEG_URL, tmpZip, (progress) => {
      sendStatus(win, 'downloading', progress, `FFmpegをダウンロード中... ${progress}%`);
    })
      .then(() => {
        sendStatus(win, 'extracting', 0, '展開中...');
        // 2. 展開
        return extractZip(tmpZip, os.tmpdir(), win);
      })
      .then((extractedDir) => {
        sendStatus(win, 'installing', 80, 'インストール中...');
        // 3. bin/ の中身だけを installDir にコピー
        const binDir = path.join(extractedDir, 'bin');
        if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

        for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
          const src = path.join(binDir, exe);
          const dst = path.join(installDir, exe);
          if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        }

        // 4. 一時ファイル削除
        try { fs.unlinkSync(tmpZip); } catch(e) {}
        try { fs.rmSync(extractedDir, { recursive: true, force: true }); } catch(e) {}

        sendStatus(win, 'done', 100, 'インストール完了！');
        resolve();
      })
      .catch((err) => {
        try { fs.unlinkSync(tmpZip); } catch(e) {}
        reject(err);
      });
  });
}

function sendStatus(win, stage, progress, message) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ffmpeg-setup-status', { stage, progress, message });
  }
}

/**
 * HTTPSでファイルをダウンロード（リダイレクト対応・最大10回）
 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let downloaded = 0, total = 0;

    function get(currentUrl, redirectCount) {
      if (redirectCount > 10) return reject(new Error('リダイレクトが多すぎます'));

      const protocol = currentUrl.startsWith('https') ? require('https') : require('http');

      protocol.get(currentUrl, { headers: { 'User-Agent': 'ClipX/1.0' } }, (res) => {
        // リダイレクト処理
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume(); // レスポンスボディを消費して接続を解放
          const location = res.headers.location;
          if (!location) return reject(new Error('リダイレクト先が不明です'));
          // 相対URLを絶対URLに変換
          const nextUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
          return get(nextUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ダウンロード失敗: HTTP ${res.statusCode}`));
        }

        total = parseInt(res.headers['content-length'] || '0', 10);
        const file = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0) onProgress(Math.round(downloaded / total * 100));
        });

        res.on('end', () => { file.end(() => resolve()); });
        res.on('error', (e) => { file.destroy(); reject(e); });
        file.on('error', (e) => reject(e));

      }).on('error', reject);
    }

    get(url, 0);
  });
}

/**
 * ZIPを展開（PowerShellのExpand-Archiveを使用）
 * @returns {Promise<string>} 展開されたトップディレクトリのパス
 */
function extractZip(zipPath, destDir, win) {
  return new Promise((resolve, reject) => {
    // PowerShell でZIP展開（Windows標準機能、追加インストール不要）
    const cmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`;
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 120000 }, (err) => {
      if (err) return reject(new Error('ZIP展開に失敗しました: ' + err.message));

      // 展開されたフォルダを探す（ffmpeg-x.x.x-essentials_build/）
      const entries = fs.readdirSync(destDir);
      const ffmpegDir = entries.find(e => e.startsWith('ffmpeg-') && fs.statSync(path.join(destDir, e)).isDirectory());
      if (!ffmpegDir) return reject(new Error('展開後のFFmpegフォルダが見つかりません'));

      resolve(path.join(destDir, ffmpegDir));
    });
  });
}

module.exports = {
  isFFmpegReady,
  installFFmpeg,
  resolveFFmpegPath,
  resolveFFprobePath,
};
