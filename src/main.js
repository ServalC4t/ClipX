const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { isFFmpegReady, installFFmpeg, resolveFFmpegPath, resolveFFprobePath } = require('./ffmpeg-setup');

// ---- Settings ----
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function getDefaultOutputDir() {
  const dir = path.join(app.getPath('videos'), 'ClipX');
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {} }
  return dir;
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const d = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!d.outputDir) d.outputDir = getDefaultOutputDir();
      return d;
    }
  } catch(e) {}
  return { outputDir: getDefaultOutputDir(), encoder: 'auto', previewRes: 'auto', dragLowres: true, telopPreview: true };
}

function saveSettings(s) { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8'); }

// ---- Windows ----
let mainWindow, setupWindow;

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 480, height: 520, resizable: false,
    backgroundColor: '#0d0d0d', titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d0d', symbolColor: '#555', height: 36 },
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 760, minWidth: 960, minHeight: 600,
    backgroundColor: '#0d0d0d', titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../assets/icon.png'),
    titleBarOverlay: { color: '#181818', symbolColor: '#666', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS('*:focus{outline:none!important;box-shadow:none!important;}');
    mainWindow.webContents.executeJavaScript('document.body.focus();');
  });
}

let detectedEncoderCache = null;
let activeExportProcs = [];

app.whenReady().then(async () => {
  if (isFFmpegReady()) {
    // 起動時にエンコーダー検出
    try {
      detectedEncoderCache = await detectEncoder(resolveFFmpegPath());
    } catch(e) { detectedEncoderCache = 'cpu'; }
    createMainWindow();
  }
  else { createSetupWindow(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('start-ffmpeg-install', async () => {
  try {
    await installFFmpeg(setupWindow);
    setTimeout(() => { setupWindow.close(); createMainWindow(); }, 1500);
  } catch(err) { setupWindow.webContents.send('ffmpeg-setup-error', err.message); }
});

ipcMain.on('skip-ffmpeg-install', () => { setupWindow.close(); createMainWindow(); });

// ---- IPC ----
ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '動画ファイルを開く',
    filters: [{ name: '動画', extensions: ['mp4','mov','avi','mkv','ts','flv','m2ts','wmv','webm'] }],
    properties: ['openFile']
  });
  return r.filePaths[0] || null;
});

ipcMain.handle('pick-directory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.filePaths[0] || null;
});

ipcMain.handle('get-video-info', async (_, filePath) => {
  return new Promise((resolve, reject) => {
    execFile(resolveFFprobePath(), ['-v','quiet','-print_format','json','-show_format','-show_streams', filePath], { maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err) return reject(err.message);
      try {
        const info = JSON.parse(stdout);
        const vs = info.streams.find(s => s.codec_type === 'video');
        const fmt = info.format;
        const fpsStr = vs ? vs.r_frame_rate : '30/1';
        const [num, den] = fpsStr.split('/').map(Number);
        resolve({ duration: parseFloat(fmt.duration), size: parseInt(fmt.size), width: vs ? parseInt(vs.width) : 0, height: vs ? parseInt(vs.height) : 0, codec: vs ? vs.codec_name : '', bitrate: parseInt(fmt.bit_rate), fps: den ? num/den : 30, filePath });
      } catch(e) { reject('動画情報の取得に失敗しました'); }
    });
  });
});

ipcMain.handle('choose-output-path', async (_, defaultName) => {
  const s = loadSettings();
  const outDir = s.outputDir || getDefaultOutputDir();
  if (!fs.existsSync(outDir)) { try { fs.mkdirSync(outDir, { recursive: true }); } catch(e) {} }
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '書き出し先を選択',
    defaultPath: path.join(outDir, defaultName),
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  return r.filePath || null;
});

// ---- Encoder detection ----
function detectEncoder(ffmpegPath) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ['-encoders'], { maxBuffer: 1024*1024 }, (err, stdout) => {
      if (err) return resolve('cpu');
      if (stdout.includes('h264_nvenc')) resolve('nvenc');
      else if (stdout.includes('h264_amf')) resolve('amf');
      else if (stdout.includes('h264_qsv')) resolve('qsv');
      else resolve('cpu');
    });
  });
}

function resolveEncoder(setting, detected) {
  const enc = setting === 'auto' ? detected : setting;
  return { nvenc: 'h264_nvenc', amf: 'h264_amf', qsv: 'h264_qsv', cpu: 'libx264' }[enc] || 'libx264';
}

// ---- Export ----
ipcMain.handle('export-clip', async (_, { clips, outputPath, preset, encoder }) => {
  const ffmpeg = resolveFFmpegPath();
  const s = loadSettings();
  const tmpDir = s.tempDir || os.tmpdir();
  const tmpFiles = [];

  const detected = await detectEncoder(ffmpeg);
  const videoEnc = resolveEncoder(encoder || 'auto', detected);
  const isCPU = videoEnc === 'libx264';

  const audioBitrate = preset.audioBitrate || '128k';
  const audioKbps = parseInt(audioBitrate) * 1000;
  const totalBps = (preset.totalBitrateMbps || 6) * 1e6;
  const videoBitrate = `${Math.max(0.5, (totalBps - audioKbps) / 1e6).toFixed(2)}M`;
  const fpsArg = preset.fps === 'source' ? null : (preset.fps || '30');
  const maxW = preset.maxWidth || 1280, maxH = preset.maxHeight || 720;

  function scaleFilter(stretch) {
    if (stretch) return `scale=${maxW}:${maxH}:force_original_aspect_ratio=increase,crop=${maxW}:${maxH},setsar=1`;
    return `scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
  }

  function runFF(args, durHint, pOff, pRange) {
    return new Promise((resolve, reject) => {
      const proc = execFile(ffmpeg, args, { maxBuffer: 500*1024*1024 });
      activeExportProcs.push(proc);
      proc.stderr.on('data', d => {
        const m = d.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m && durHint) {
          const e = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseFloat(m[3]);
          mainWindow.webContents.send('export-progress', Math.min(99, (pOff||0) + Math.round(e/durHint*(pRange||90))));
        }
      });
      proc.on('close', code => {
        activeExportProcs = activeExportProcs.filter(p => p !== proc);
        code === 0 ? resolve() : reject(`FFmpeg error (code ${code})`);
      });
      proc.on('error', e => {
        activeExportProcs = activeExportProcs.filter(p => p !== proc);
        reject(e.message);
      });
    });
  }

  const hasTransition = clips.slice(1).some(c => c.transition && c.transition.id !== 'cut');

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const ext = hasTransition ? '.mkv' : '.mp4';
    const tmp = path.join(tmpDir, `clipx_${Date.now()}_${i}${ext}`);
    tmpFiles.push(tmp);
    const pOff = Math.round(i / clips.length * 70), pRange = Math.round(70 / clips.length);
    const adj = c.adjustments || { volume: 1, speed: 1, brightness: 0, gamma: 1, contrast: 1 };
    const vol = adj.volume ?? 1;
    let vf = scaleFilter(c.stretch169);
    const needsEq = adj.brightness !== 0 || adj.gamma !== 1 || adj.contrast !== 1;
    if (needsEq) vf += `,eq=brightness=${adj.brightness}:gamma=${adj.gamma}:contrast=${adj.contrast}`;
    if (adj.speed && adj.speed !== 1) vf += `,setpts=${(1/adj.speed).toFixed(4)}*PTS`;
    // 音声フィルター
    const atempoFilters = [];
    if (adj.speed && adj.speed !== 1) {
      let s = adj.speed;
      while (s > 2) { atempoFilters.push('atempo=2.0'); s /= 2; }
      while (s < 0.5) { atempoFilters.push('atempo=0.5'); s /= 0.5; }
      atempoFilters.push(`atempo=${s.toFixed(4)}`);
    }
    if (vol !== 1) atempoFilters.push(`volume=${vol.toFixed(4)}`);
    const afArg = atempoFilters.length ? atempoFilters.join(',') : null;

    // クリップタイトル burn-in
    const telop = c.telop;
    if (telop && telop.enabled && telop.text) {
      const fontSize = telop.fontSize || 32;
      const fontColor = (telop.color || '#ffffff').replace('#', '');
      const bgColor = (telop.bgColor || '#000000').replace('#', '');
      const bgOpacity = Math.round((telop.bgOpacity || 0.6) * 255).toString(16).padStart(2,'0');
      const telopDur = telop.duration || 3;
      const safeText = telop.text.replace(/[:'\\%\[\]]/g, ' ');
      const fontFileMap = {
        sans:   'C\\:/Windows/Fonts/meiryo.ttc',
        serif:  'C\\:/Windows/Fonts/msmincho.ttc',
        mono:   'C\\:/Windows/Fonts/lucon.ttf',
        impact: 'C\\:/Windows/Fonts/impact.ttf',
      };
      const fontFile = process.platform === 'win32'
        ? (fontFileMap[telop.font] || fontFileMap.sans)
        : '/System/Library/Fonts/Helvetica.ttc';
      const enable = `enable='between(t,0,${telopDur})'`;
      const telopXPct = (telop.x ?? 3) / 100;
      const telopYPct = (telop.y ?? 3) / 100;
      const tx = `(w*${telopXPct.toFixed(4)})`;
      const ty = `(h*${telopYPct.toFixed(4)})`;
      let drawtextFilter = '';
      switch(telop.style || 'box') {
        case 'simple':
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=0x${fontColor}:shadowx=2:shadowy=2:shadowcolor=0x000000AA:x=${tx}:y=${ty}:${enable}`;
          break;
        case 'box':
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=0x${fontColor}:box=1:boxcolor=0x${bgColor}${bgOpacity}:boxborderw=8:x=${tx}:y=${ty}:${enable}`;
          break;
        case 'underline':
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=0x${fontColor}:shadowx=1:shadowy=1:shadowcolor=0x000000CC:box=1:boxcolor=0x${fontColor}20:boxborderw=2:x=${tx}:y=${ty}:${enable}`;
          break;
        case 'gradient':
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=0x${fontColor}:box=1:boxcolor=0x${bgColor}${bgOpacity}:boxborderw=6:x=${tx}:y=${ty}:${enable}`;
          break;
        case 'game':
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${Math.round(fontSize*1.2)}:fontcolor=0x${fontColor}:borderw=3:bordercolor=0x000000FF:shadowx=3:shadowy=3:shadowcolor=0x00000099:x=${tx}:y=${ty}:${enable}`;
          break;
        default:
          drawtextFilter = `drawtext=text='${safeText}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=0x${fontColor}:box=1:boxcolor=0x${bgColor}${bgOpacity}:boxborderw=8:x=${tx}:y=${ty}:${enable}`;
      }
      vf += `,${drawtextFilter}`;
    }

    let args;
    if (hasTransition) {
      args = ['-y', '-ss', String(c.startTime), '-i', c.inputPath, '-t', String(c.duration / (adj.speed || 1))];
      if (fpsArg) args.push('-r', fpsArg);
      args.push('-vf', vf);
      if (afArg) args.push('-af', afArg);
      args.push('-c:v', 'ffv1', '-c:a', 'pcm_s16le', tmp);
    } else {
      args = ['-y', '-ss', String(c.startTime), '-i', c.inputPath, '-t', String(c.duration / (adj.speed || 1)), '-c:v', videoEnc, '-b:v', videoBitrate];
      if (isCPU) args.push('-preset', preset.encPreset || 'fast');
      if (fpsArg) args.push('-r', fpsArg);
      args.push('-vf', vf);
      if (afArg) args.push('-af', afArg);
      args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ar', '44100', '-movflags', '+faststart', tmp);
    }
    await runFF(args, c.duration, pOff, pRange);
  }

  mainWindow.webContents.send('export-progress', 72);

  if (clips.length === 1) {
    fs.copyFileSync(tmpFiles[0], outputPath);
  } else {
    const allCut = clips.slice(1).every(c => !c.transition || c.transition.id === 'cut');
    if (allCut) {
      const listPath = path.join(tmpDir, `clipx_list_${Date.now()}.txt`);
      fs.writeFileSync(listPath, tmpFiles.map(f => `file '${f.replace(/\\/g,'/')}'`).join('\n'));
      await runFF(['-y','-f','concat','-safe','0','-i',listPath,'-c','copy',outputPath], null, 75, 22);
      try { fs.unlinkSync(listPath); } catch(e) {}
    } else {
      const inputs = tmpFiles.flatMap(f => ['-i', f]);
      let fg = '', vCur = '[0:v]', aCur = '[0:a]', offset = 0;
      for (let i = 1; i < tmpFiles.length; i++) {
        const t = clips[i].transition || { id: 'dissolve', duration: 0.5 };
        const dur = t.duration || 0.5;
        offset += clips[i-1].duration - (t.id && t.id !== 'cut' ? dur : 0);
        const last = i === tmpFiles.length - 1;
        const vOut = last ? '[vout]' : `[v${i}]`, aOut = last ? '[aout]' : `[a${i}]`;
        const xf = { dissolve:'fade', fade:'fadeblack', wipeleft:'wipeleft', wiperight:'wiperight', slideleft:'slideleft' }[t.id] || 'fade';
        fg += `${vCur}[${i}:v]xfade=transition=${xf}:duration=${dur}:offset=${offset.toFixed(3)}${vOut};`;
        fg += `${aCur}[${i}:a]acrossfade=d=${dur}${aOut};`;
        vCur = vOut; aCur = aOut;
      }
      fg = fg.replace(/;$/, '');
      const totalDur = clips.reduce((s, c) => s + c.duration, 0);
      await runFF(['-y',...inputs,'-filter_complex',fg,'-map','[vout]','-map','[aout]','-c:v',videoEnc,'-b:v',videoBitrate,'-sws_flags','lanczos','-c:a','aac','-b:a',audioBitrate,'-movflags','+faststart',outputPath], totalDur, 75, 22);
    }
  }

  tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
  mainWindow.webContents.send('export-progress', 100);
  const stat = fs.statSync(outputPath);
  return { success: true, sizeMB: (stat.size/1024/1024).toFixed(1) };
});

ipcMain.handle('extract-waveform', async (_, { filePath, samples }) => {
  const ffmpeg = resolveFFmpegPath();
  const n = samples || 2000;
  return new Promise((resolve) => {
    // PCMデータをrawで出力してピークを計算
    const args = ['-i', filePath, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'];
    const proc = require('child_process').spawn(ffmpeg, args, { stdio: ['ignore','pipe','ignore'] });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stdout.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const total = buf.length / 4;
        const blockSize = Math.max(1, Math.floor(total / n));
        const peaks = [];
        for (let i = 0; i < n; i++) {
          let max = 0;
          for (let j = 0; j < blockSize; j++) {
            const idx = (i * blockSize + j) * 4;
            if (idx + 4 > buf.length) break;
            max = Math.max(max, Math.abs(buf.readFloatLE(idx)));
          }
          peaks.push(Math.min(1, max));
        }
        resolve(peaks);
      } catch(e) { resolve([]); }
    });
    proc.on('error', () => resolve([]));
  });
});

ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, s) => { saveSettings(s); return true; });
ipcMain.handle('get-detected-encoder', () => detectedEncoderCache || 'cpu');
ipcMain.handle('show-in-explorer', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('open-x-post', () => shell.openExternal('https://twitter.com/compose/tweet'));
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('cancel-export', () => {
  activeExportProcs.forEach(p => { try { p.kill(); } catch(e) {} });
  activeExportProcs = [];
  return true;
});

ipcMain.handle('save-project', async (_, data) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'プロジェクトを保存', defaultPath: 'project.clipx',
    filters: [{ name: 'ClipX プロジェクト', extensions: ['clipx'] }]
  });
  if (!r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return r.filePath;
});

ipcMain.handle('load-project', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'プロジェクトを開く',
    filters: [{ name: 'ClipX プロジェクト', extensions: ['clipx'] }],
    properties: ['openFile']
  });
  if (!r.filePaths[0]) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch(e) { return null; }
});
