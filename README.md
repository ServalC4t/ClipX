# ClipX — X特化型ゲームクリップ編集ソフト

Xへの投稿に特化したゲームクリップ編集デスクトップアプリ。Electron製・Windows対応。

---

## ダウンロード

[Releases](https://github.com/ServalC4t/ClipX/releases) からインストーラー（`.exe`）をダウンロードしてください。

---

## 機能

- **複数動画の読み込み** — MP4, MOV, AVI, MKV, TS, FLV, M2TS, WMV, WebM
- **クリップごとのトリム** — タイムラインのハンドルをドラッグ
- **ドラッグ&ドロップ並び替え** — サイドバーのクリップリスト
- **トランジション** — カット / フェード / ディゾルブ / ワイプ
- **X向けプリセット書き出し**
  - 無料プラン: 140秒 / 512MB / H.264 / 1080p
  - プレミアム: 180秒 / 2GB / H.264 / 1080p
  - カスタムプリセット対応
- **書き出し後にXの投稿画面を直接開く**
- **12言語対応** — 日本語 / English / 中文 / 한국어 / Español / Français / Deutsch / Português / Русский / Italiano / Polski / Türkçe
- **OS言語の自動検出**

---

## 開発者向け

### 必要なもの

- Node.js 18以上
- FFmpeg（Windowsバイナリ）

### セットアップ

```bash
npm install
```

### FFmpegの配置

以下のどちらか：

- **A)** `ffmpeg.exe` と `ffprobe.exe` を PATH に追加
- **B)** プロジェクト直下に `ffmpeg/` フォルダを作り、`ffmpeg.exe` と `ffprobe.exe` を配置

FFmpegは [ffmpeg.org](https://ffmpeg.org/download.html) からダウンロード。

### 起動

```bash
npm start
# 開発モード（DevTools付き）
npm run dev
```

### ビルド（配布用 .exe）

```bash
npm run build
```

`dist/` に NSIS インストーラーが生成されます。

---

## ライセンス

MIT
