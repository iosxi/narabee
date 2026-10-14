# DEVELOPMENT

narabee の開発メモ。利用者向けの説明は [README.md](README.md)。

## バージョンとリリースの方針

**番号の付けかた: `manifest.json` の `N.0.0` ↔ git タグ `vN`。** 初回は `1.0.0` ↔ `v1`。

XPI の中身を変えたら必ず番号を上げる。AMO で署名した番号は永久に消費され、
同じ番号では再アップロードできないので、署名前に番号を確定させること。

## 構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | MV2。`browser_action` で board を開く |
| `src/state.js` | 保存する状態の形と読み書き (背景と board で共用) |
| `src/background.js` | 埋め込み拒否の除去、枠からの脱出の阻止、右クリックメニュー |
| `src/frame.js` | board の枠に差し込み、`target="_top"` を枠の中で開かせる |
| `src/layouts.js` | レイアウトの定義 (分割の木) と位置の計算 |
| `src/board.html` / `.css` / `.js` | 並べて表示する画面 |
| `tools/build-xpi.js` | 配布用 XPI の作成 |
| `tools/sign.js` | AMO 署名 |
| `tools/fetch-signed.js` | 署名済み XPI の取得だけやり直す |
| `tools/make-icons.js` | アイコン PNG の生成 (`src/icons/*.png` は生成物) |
| `tools/make-test-build.js` / `tools/test-open.js` | 動作テスト用ビルド (製品には含めない) |

## 仕組み

### 埋め込み拒否を外す

`webRequest.onHeadersReceived` (blocking) で、`sub_frame` の応答から
`X-Frame-Options` と CSP の `frame-ancestors` 指令を取り除く。対象は
`details.frameAncestors` に board (`moz-extension://<uuid>/`) がいる枠だけ。
`frame-ancestors` は祖先を全部たどって判定されるので、枠の中のサイトが自分で
埋め込んでいる iframe も対象に含める。

### 枠の中の URL を追う

枠は別のサイトなので `iframe.contentWindow.location` は読めない。board 自身が
`webNavigation.onCommitted` / `onHistoryStateUpdated` / `onReferenceFragmentUpdated`
を聞き、`runtime.getFrameId(iframe)` で frameId と枠を対応づける。
戻る・進む・再読み込みは `tabs.executeScript({ frameId })` で枠の中から行う。

### iframe を DOM 上で動かさない

iframe を別の親へ移すと読み込み直しになる。枠は `#stage` の直下に 4 つ固定で置き、
レイアウトは位置 (`left/top/width/height` の %) を変えるだけ。使わない枠は `hidden`
にするので、レイアウトを戻せば中身もそのまま戻る。

### 枠からの脱出を防ぐ

- `target="_top"` / `_parent` のリンク・フォーム: 背景が `webNavigation.onCommitted`
  で board の枠に `frame.js` を差し込み、クリック・送信の直前に `_self` へ書き換える。
  楽天証券のログインフォームが `target="_top"`。
- スクリプトからの `top.location = ...`: ユーザー操作なしでは Firefox が
  `SecurityError` で止める (実測)。ユーザー操作つきで通った場合に備え、背景の
  `onBeforeRequest` (`main_frame`) で、board のタブを Web のページが動かそうとしたら
  取り消し、元の枠 (同じ origin の枠) で開き直す。無ければ新しいタブで開く。

## 実測した事実 (Firefox 157.0.1、2026-10-14)

自前の試験サーバー (`network.dns.localDomains` で `site-a.test` 等を手元に向ける) と
実サイトで、WebDriver BiDi から確かめた。

| 確かめたこと | 結果 |
| --- | --- |
| board の iframe に `X-Frame-Options: DENY` + `frame-ancestors 'none'` のページ | 外さないと「ブロックしたページ」、外すと表示 |
| 枠の中のクッキー (`SameSite` 無し / `Lax` / `Strict`) | 3 種とも送られる。`document.cookie` でも読める |
| 枠の中の `localStorage` | トップレベルで書いた値が読める (分離されない) |
| ユーザー操作なしの `top.location = ...` / `top.location.replace(...)` | どちらも `SecurityError` で止まる |
| ユーザー操作つき (本物のクリック) の `top.location.href = ...` | board は残り、移動先は枠の中で開く |
| github.com / www.google.com / x.com / www.youtube.com | 4 つとも枠の中で表示 |
| nikkei225jp.com/cme/ | 表示 (本文 10,000 字超)。拒否ヘッダーは無い |
| 楽天証券のログイン画面 (`/ITS/V_ACT_Login.html`) | 表示。`loginform` の `target="_top"` が送信時に `_self` になる |
| youtube.com のトップと動画ページ | 表示。動画は `readyState` 4 まで読み込まれる |

ここで言う「分離されない」は、Firefox の Total Cookie Protection が
拡張機能のページを最上位とする iframe には効かないということ。普段のログイン状態が
そのまま枠の中で使えるのはこのため。

楽天証券のログイン後のページ (`member.rakuten-sec.co.jp`) は、エラー時に
`window.top.location.replace(...)` でエラーページへ飛ばす。枠の中ではこれが
`SecurityError` になり (上の表)、エラーページへは移らない。ログイン後の動作は
資格情報が無いので確かめていない。

### 拡張機能の新しいタブ (follient など) は枠に入れられない (見送り)

- 今の新しいタブの URL は `browserSettings.newTabPageOverride.get({})` で取れる
  (follient なら `moz-extension://<uuid>/src/newtab.html`)。
- ただし、その拡張機能が `web_accessible_resources` で公開していないと、枠は
  `about:blank` のまま。公開すると、どの Web ページからも埋め込めるようになる。
- 公開しても、ほかの拡張機能のページの iframe に入れられた拡張機能のページからは、
  Firefox が `browser.bookmarks` だけを取り上げる (`tabs` や `storage`、
  `runtime.sendMessage` は残る)。普通のタブで開けば使える。

follient 側を変える必要があり、上の公開は安全性を下げるので、2026-10-14 に見送った。

## 作業手順

### 開発時の読み込み

```sh
npx web-ext run --source-dir .
npx web-ext lint --source-dir . --ignore-files "tools/**" "dist/**"
```

または `about:debugging#/runtime/this-firefox` から `manifest.json` を選ぶ。

### 動作テスト

```sh
node tools/make-test-build.js <出力先>
```

`tools/test-open.js` を背景に足したビルドができる。WebDriver BiDi では
`moz-extension://` へ移れないので、Web のページ `.../open-board?state=<JSON>` を
開くと状態を保存してから board を開き、`.../send-load?i=<枠>&url=<URL>` を開くと
右クリックの「枠に送る」と同じ指示を board に送る。

BiDi で踏んだもの:

- `input.performActions` と `browsingContext.captureScreenshot` は board (特権の
  文脈) では使えない。クリックは枠 (Web のページ) の文脈へ枠内の座標で送り、
  境目のドラッグは `PointerEvent` を `dispatchEvent` で送って確かめた。
  合成イベントでは `setPointerCapture` が失敗しうるので、board.js は try で包んでいる。
- 見た目は、`src/` を普通の Web ページとして配り、`browser` を最小限真似た
  スクリプトを先に読ませて撮った。
- 枠の文脈での `script.evaluate` はページ側の世界で走るので、`frame.js` が
  立てた `window.__narabeeFrame` は見えない (効いているかは結果で判断する)。
- 新規プロファイルの最初の文脈は特権ページなので、`setViewport` は Web の
  ページへ移ってから呼ぶ。

### XPI の作成

```sh
node tools/build-xpi.js     # -> dist/narabee-<version>.xpi
```

### 署名

```powershell
. C:\projects\.keys\follient\apikey.ps1; node tools/sign.js
```

AMO の API キーはアカウント単位なので、follient と同じものを使う。
`--channel unlisted` 固定で、`dist/narabee-<version>-signed.xpi` に出る。
`browser_specific_settings.gecko.id` は AMO 上でアカウントに永続的に紐づくので
変更しないこと。

### アイコン

```sh
node tools/make-icons.js
```
