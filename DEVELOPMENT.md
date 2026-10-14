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

### Service Worker を持つサイト (v2)

サイトが Service Worker を持っていると、枠の読み込みは次のように進む
(Firefox 158 の利用者環境で YouTube が `xfoBlocked` になり、手元で再現して記録した)。

1. 枠の要求 (`sub_frame`、board のタブ、`frameAncestors` に board) が始まる
2. 同じ URL への内部の振り替え (`onBeforeRedirect`) で Service Worker に渡る
3. Service Worker が同じ URL を取り直す。この要求も `sub_frame` だが、
   `tabId` も `frameId` も -1、`frameAncestors` は空、`originUrl` はそのサイト

3 の応答に `X-Frame-Options` が付いたまま枠に返るので、v1 では拒否されていた。
v2 では 1 と 2 で URL を 30 秒だけ覚え、3 で「`tabId` が -1・同じ URL・
`originUrl` が同じ origin」なら board の枠向けとみなして外す。覚えた URL は
一度使ったら消す。Service Worker を持たないサイトや、普通のタブには影響しない。

Service Worker がネットに出ずに Cache Storage から返すサイトは、webRequest を
通らないので外せない (YouTube はネットに取りに行く)。

### パスキー (WebAuthn) を枠に許す (v3)

楽天証券の「パスキーでログイン」は `member.rakuten-sec.co.jp/app/MhLogin.do?login_type=2`
の先で `navigator.credentials.get()` を呼び、失敗するとログイン画面に戻る。
別 origin の iframe での WebAuthn は、埋め込む側が `allow` で
`publickey-credentials-get` を委ねないと使えない。枠の `allow` に
`publickey-credentials-get *; publickey-credentials-create *` を足した。

| 枠の `allow` (localhost の試験ページで `credentials.get`) | 結果 |
| --- | --- |
| WebAuthn なし (v2) | 即座に `NotAllowedError: CredentialsContainer request is not allowed.` |
| WebAuthn あり (v3) | 許可の確認を通り、認証器を探す段階へ進む (headless には認証器が無く `UnknownError`) |

普通のタブでの対照は、headless ではフォーカスが無いため同じ `NotAllowedError` になり、
比較に使えなかった。本物のパスキーでの成否は確かめていない。

### Google のログインは普通のタブで (v3)

枠の中から `accounts.google.com` を開くと、Google のサーバーが **401** を返す
(`Error 401 (不正なリクエスト)`)。拒否ヘッダーではなく Google 側の判断なので外さない。
board の直下の枠が `accounts.google.com` へ移ろうとしたら、`onBeforeRequest` で
取り消して同じ URL を新しいタブで開く (枠は元のページのまま残る)。そのタブが
`accounts.` で始まらないホストで読み込み完了したら、ログインが済んだとみなして
タブを閉じ、その URL を枠に読み込む (google → accounts.youtube.com → youtube と渡るため)。
対象のホストは `LOGIN_IN_TAB` に並べる。

### スクロール位置を覚えて戻す (v6)

board を開く (読み直す) と、枠には保存した URL を `iframe.src` で読み込み直すので、
普通のタブを読み直したときのような位置の復元は効かない。`frame.js` が `scroll` を
250ms ごとにまとめて `{ type: 'frame-scroll', url, x, y }` で知らせ、board が
`sender.frameId` から枠を引いて `state.panes[i].scroll` に保存する。

board を開いたとき、保存した URL と `scroll.url` が同じ枠は、その枠の最初の
Web のページの `onCommitted` で、`executeScript` (`document_idle`) から
`scrollTo` を 150ms ごとに最大 40 回やり直す。後から中身が伸びるページにも届く。
`wheel` / `keydown` / `touchstart` / `mousedown` が来たらやめる。戻し終わるまでは
その枠の位置を記録しない (読み込み直後の 0 で上書きしないため)。

- 枠を作った直後の `about:blank` の `onCommitted` も届く。これを「別の URL が
  読み込まれた」と扱うと復元をやめてしまうので、Web のページだけを見る。
- 楽天証券のログイン画面は `window.onload` でログイン ID の欄に焦点を移し、
  その欄が見える位置まで動く。ページの意図なので逆らわない。
- 枠ごとの ↻ は `location.reload()` なので、Firefox が自分で位置を保つ。

### 上の帯を隠す (v7)

帯 (`#bar`) は `body.bar-hidden` で隠す。開いた直後 (`init`) とツールバーのボタン
(背景が `showBoard()` の後に `{ type: 'show-bar', tabId }` を送る) で出し、
レイアウトのボタン・帯の × (`#bar-close`)・`BAR_AUTO_HIDE_MS` (15 秒) で隠す。
帯の上にマウスがある間 (`pointerenter`〜`pointerleave`) は数えず、離れてから数え直す。
帯は普通の段なので、隠すと枠が上に広がる (枠 1 の上端 34px → 2px)。

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
  で board の枠に `frame.js` を差し込み、`target` / `formtarget` 属性を `_self` へ
  書き換える。楽天証券のログインフォームが `target="_top"`。

  v4 までは送信の瞬間 (`submit` イベント) に書き換えていたが、楽天のログインボタンは
  onclick で `document.loginform.submit()` を呼び、スクリプトからの `submit()` は
  `submit` イベントを出さない。`_top` のまま POST がタブ全体に出て、見張りが枠に
  読み直す際に本文 (ID・パスワード) が落ちて GET になり、ログインエラーになっていた。
  v5 では `MutationObserver` で、属性が現れた時点 (後から足された要素も) で書き換える。
- 楽天証券の会員ページのメニュー (保存してもらったページで 125 個) は
  `onclick="memberPageJump('...')"`。`memberPageJump()` は `typeof parent.IFAWebMain` を
  調べるが、枠の `parent` は board なので `SecurityError` になり、それを `catch` で
  握りつぶすので、押しても何も起きなかった。v5 の `frame.js` は、クリックの捕捉段階で
  ページの `memberPageJump` を包み直し、**呼んでいる間だけ** ページから見た `parent` を
  自分自身にする (`exportFunction`、終わったら元の記述子に戻す)。最後の
  `top.location.href` に進み、下の見張りが枠の中の移動に振り替える。

  `parent` を常に自分自身にする案は捨てた。`top` は上書きできないので
  「`parent` をたどって `top` に着くまで」の処理が終わらず、nikkei225jp.com/cme/ の枠が
  `about:framecrashed` になり、楽天の公開ページも固まった (`defineProperty`・代入・
  `<script>` 差し込みの 3 通りとも)。

  包み済みかどうかは関数に付けた目印 (`__narabeeWrapped`) で見る。拡張機能側とページ側では
  同じ関数でも別のオブジェクトに見えるので、`WeakSet` ではクリックのたびに包み直していた
  (ページ側で `memberPageJump` の同一性を比べて確かめた)。

  包んだ関数から元の関数を呼ぶときは `fn.call(self, ...args)` にする。
  `fn.apply(self, args)` だと `args` が拡張機能側の配列で、ページ側から
  `Permission denied to access property "length"` になる。
- スクリプトからの `top.location = ...` / `top.location.replace(...)`: ユーザー操作
  なしでは、Firefox のリダイレクト防止が `SecurityError` で止め、「Firefox がこのサイトで
  リダイレクトをブロックしました」を出す。楽天証券の会員ページ (`member.rakuten-sec.co.jp`)
  は画面の切り替え (ログイン後の会員ホームへ、セッション切れの案内へ) に
  `window.top.location.replace(...)` を使うので、v3 まではログインできなかった。
  通知の「設定」で許可しても、最上位が拡張機能のページなので効かなかった。

  v4 では枠に `sandbox` を付け、`allow-top-navigation` を明示的に許す。こうすると
  Firefox はリダイレクト防止で止めず、タブ全体の移動の要求が出る。これを背景の
  `onBeforeRequest` (`main_frame`) で取り消し、元の枠 (URL が一致する枠、無ければ同じ
  origin の枠) で開き直す。無ければ新しいタブで開く。

  `top.location = location.href` のような「枠から抜け出す」処理は、枠で読み直すと同じ
  処理がまた走る。移動先が今の枠の URL と同じなら何もしない。

  `sandbox` には `allow-same-origin` を含めて origin を保ち、スクリプト・フォーム・
  ポップアップ・ダウンロード・モーダルなど普通の枠と同じ動作を許している。
  付けた後も、クッキー・localStorage・Service Worker・WebAuthn・動画の再生が
  変わらないことを確かめた (下の表)。

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
| 先に普通のタブで YouTube を開き、Service Worker が登録された後 | v1 は `about:neterror?e=xfoBlocked`。v2 はトップ・動画・`youtube.com` (転送あり) とも表示 |
| AdGuard AdBlocker 5.5.3.5 を入れた状態 (Service Worker なし) | 表示 (AdGuard は無関係だった) |
| 互い違い (`zigv` / `zigh`) | 枠 1・4 が 65%、枠 2・3 が 35% |
| 枠の中の YouTube で「ログイン」 | v2 は 401。v3 は枠が YouTube のまま、ログイン画面が新しいタブで開く |
| ログイン用タブを YouTube の動画ページへ移す | タブが閉じ、枠に同じ動画ページが読み込まれる |
| 枠で `top.location.replace(別の URL)` (ユーザー操作なし) | v3 は `SecurityError`。v4 は枠の中でその URL に移り、board は残る |
| 枠で `top.location = location.href` | v4 はエラーにならず、読み直しは起きない (13 秒間でサーバーへの要求は 1 回) |
| v4 (`sandbox` あり) での WebAuthn / Service Worker 登録済みの YouTube / Google ログインの振り替え / YouTube 動画 | いずれも v3 と同じ結果 (動画は `readyState` 4) |
| × ボタン | 枠が `about:blank` になり、URL 欄と保存上の URL も空になる |
| 楽天と同じ作りのフォーム (`target="_top"` の POST を onclick から `submit()`) | v4 は枠に `GET`・本文なし。v5 は `POST` で `loginid=…&passwd=…` が届く |
| 楽天と同じ作りのメニュー (`memberPageJump`) | v4 は `SecurityError` を握りつぶして何も起きない。v5 は枠の中で移動先へ |
| v5 の差し替えの前後の `parent === window` | 呼ぶ前 false、実行中 true、呼んだ後 false (2 回目も同じ) |
| クリック 3 回の前後の `memberPageJump` | 同じ関数のまま (包み直さない) |
| board を読み直す (2500 / 1.5 秒後に伸びるページで 3000 / 動かしていない枠) | 1 秒後 2500 / 0 / 0、6 秒後 2500 / 3000 / 0 |
| 同じく nikkei225jp (1500) / 楽天ログイン画面 (800) | 1 秒後 1500 / 800。楽天は onload の焦点移動で 234 へ動く |
| 戻した後に利用者がスクロール (1200) | 1200 が記録される |
| 帯: 開いた直後 / × / ボタン相当の指示 / レイアウトのボタン | 出る / 隠れる / 出る / 隠れる |
| 帯: 出して 13 秒 / 16 秒 | 出ている / 隠れる |
| 帯: マウスを乗せて 17 秒 / 離してから | 出ている / 17 秒後に隠れる (1 秒ごとの確認) |
| v5 で nikkei225jp / 楽天の公開ページ / YouTube | 固まらず表示 (`parent` は元のまま) |

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
