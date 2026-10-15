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

帯 (`#bar`) は `body.bar-hidden` で隠す (v12 からは出す条件が変わった。下の「帯を出す条件 (v12)」)。開いた直後 (`init`) とツールバーのボタン
(背景が `showBoard()` の後に `{ type: 'show-bar', tabId }` を送る) で出し、
レイアウトのボタン・帯の × (`#bar-close`)・`BAR_AUTO_HIDE_MS` (15 秒) で隠す。
帯の上にマウスがある間 (`pointerenter`〜`pointerleave`) は数えず、離れてから数え直す。
帯は普通の段なので、隠すと枠が上に広がる (枠 1 の上端 34px → 2px)。

### タブ (ウィンドウ) の題名 (v8)

「narabee」だけではウィンドウを見分けられないので、枠 1 のページの題名を付けて
`narabee(題名)` にする (Firefox はこれに「— Mozilla Firefox」を付けてウィンドウの題名にする)。
枠の中は別のサイトなので、`frame.js` が `document.title` を DOMContentLoaded と
1 秒ごとの確認で、変わったときだけ `{ type: 'frame-title', title }` で知らせる
(後から題名を変えるページ、ni225simple が設定を付け足す場合に追従するため)。
題名を消すのは枠を空にしたときだけ。`#` の変化やページ内の切り替えでは題名の
知らせが来ないので、URL が変わったからといって消すと題名が空のままになる。

### ウィンドウごとの board (v9)

v8 までは board がブラウザ全体で 1 つの前提で、ツールバーのボタンは最初に見つかった
board を前面に出していた。ウィンドウ 2 で押すとウィンドウ 1 の board に帯が出ていた。

- ツールバーのボタンと右クリックの「枠に送る」は、押したウィンドウの board
  (`boardInWindow(windowId)`) だけを相手にする。無ければそのウィンドウに開く。
- 保存先は board ごと。新しく開く board の URL に `?b=<8 桁>` を付け、
  `storage.local` の `state:<識別子>` に保存する。URL に入れておくので、Firefox が
  タブを復元すれば同じ保存先に戻る。識別子の無い board (v8 までに開いたもの) は
  これまでどおり `state` を使う。
- 背景から board への `load` は `tabId` を付けて宛先を決める (付いていないものは
  試験用の入口からの指示で、どの board も受ける)。
- 閉じた board の保存内容は消さない (閉じたタブを開き直したときに戻せるように)。
- 動作テストのため、背景はボタンと「枠に送る」の処理を `globalThis.narabeeToolbarClick` /
  `narabeeSendToPane` として公開している (`tools/test-open.js` の `/toolbar`、`/menu-send` が呼ぶ)。

### 1 つのウィンドウに複数の board (v10)

v9 の「ウィンドウごとに 1 つ」をやめ、1 つのウィンドウに幾つでも開けるようにした。

- ツールバーのボタン (`onToolbarClick`): そのウィンドウに board があれば 1 つ足す。
  無ければ閉じた board をすべてそのウィンドウに復元し (`updatedAt` の古い順、最後を前面に)、
  復元するものが無ければ新しく開く。帯は出さない (開いた board が自分で出す)。
- 閉じた board = `storage.local` に保存があり、どのウィンドウにも開いていない
  (`tabs.query({})` の URL の `?b=` に無い) もの。再起動後にまだ選ばれていない
  (読み込まれていない) タブも URL で数えるので、二重に復元しない。
- board のタブを閉じたとき (`tabs.onRemoved`、ウィンドウごと閉じた場合を除く)、枠が
  全部空なら保存を消す。消さないと、試しに開いて閉じただけの board まで毎回復元される。
  board が閉じる直前の保存を 500ms 待ってから判断する。
- 帯の出し直しは、board のタブの右クリック「narabee レイアウトバーを表示」(`MENU_BAR`)。
  `menus.onShown` で board のタブのときだけ見せる。
- 「枠に送る」は、そのウィンドウで最後に使っていた board (`lastAccessed` が最大) に送る。
  まだ読み込まれていない board なら保存先に書いてから前面に出す。

### 倍率のダイアログ (v11)

見出しの倍率 (`data-act="zoomdialog"`) は、v10 までの「押すと 100%」をやめ、ダイアログ
(`#zoom-dialog`、board に 1 つ) を開く。入力した値はすぐには反映しない。

- 「セット」(`form` の `submit`、Enter はフォームの暗黙の送信) で反映して閉じる。
  10〜500 の数でなければ、ダイアログ内に知らせて開いたままにする。
- 「リセット」は 100% にして閉じる。
- × ・Esc・ダイアログの外の `pointerdown` で、入力を捨てて閉じる。枠の中のページを
  押したときは board に `pointerdown` が来ないので、`window` の `blur` で閉じる。
- 同じ枠の倍率のボタンをもう一度押すと閉じる (外を押した扱いにはしない)。
- 閉じるとき、見えなくなった入力欄に焦点を残さない。
- −/+ は手入力の値からも次の段階へ進む (120% から + で 125%)。

### 帯を出す条件 (v12)

遠隔の利用者から「画面を更新するとレイアウトバーが出る」と指摘があった。v11 までは board が
読み込まれるたびに (`init`) 出していたので、F5 や Firefox の再起動でタブが戻ったときにも出ていた。
v12 では **board のタブを足したときだけ** 出す。

- `board.html` の `<body>` は最初から `bar-hidden`。
- 背景の `createBoard` (ツールバーのボタンでの新規・復元、「枠に送る」で board が無かったとき) が
  識別子を `showBarOnHello` に入れ、その board の `board-hello` への返事に `showBar: true` を付ける
  (一度使ったら消す)。タブの ID ではなく識別子で覚えるので、`tabs.create` の返事より先に
  board が名乗り出ても取りこぼさない。
- タブの右クリック「narabee レイアウトバーを表示」は従来どおり。ただし board がまだ読み込まれて
  いない (再起動後に選ばれていない、破棄された) タブでは、指示を送っても届かないので、識別子を
  `showBarOnHello` に入れてから前面に出す (読み込まれたときに出る)。
- 破棄 (`tabs.discard`、メモリ節約) された board のタブは、`tabs.onUpdated` の `discarded` で
  `boards` から外す。外さないと「読み込まれている」とみなして指示を送り、届かずに終わる
  (帯が出せず、「枠に送る」も消える)。外さないビルドで実際に帯が出なかったことを確かめた。

「どうやっても出せない / 消せない」にならないことの確認 (下の表):
出す手段は、どの状態の board のタブ (読み込み済み・未読み込み・破棄済み) でも右クリックの
「表示」が効く。消す手段は × ・レイアウトのボタン・15 秒の 3 つで、帯が出ていれば常に効く。

### 自動の再読み込み (v12)

枠ごとに間隔 (`state.panes[i].reload`、秒。0 は無し) を覚える。保存先は枠の URL と同じ
`storage.local` の `state:<識別子>` なので、Firefox を終了しても残る。

- 読み直しは ↻ と同じ `location.reload()` を枠に `executeScript` で入れる (スクロール位置を
  Firefox が保つ。履歴も増えない)。差し込めない (エラーページなど) ときは `iframe.src` に
  覚えている URL を入れ直す。
- 時計は `setTimeout` を枠ごとに 1 つ。枠の `webNavigation.onCompleted` / `onErrorOccurred` で
  今から間隔の後に置き直す。読み込みに間隔より長くかかるページを途中で読み直し続けないため。
  時計が鳴ったとき読み込みの途中 (`onBeforeNavigate` から 60 秒以内) なら、その回は飛ばす。
- 枠の中の入力欄 (文字を打つ種類の `input`、`textarea`、`select`、`contenteditable`) に
  焦点があり、その枠の文書が焦点を持つ (`document.hasFocus()`) ときは飛ばす。
- **POST で開いたページは読み直さない。** 枠の中で POST の結果を `location.reload()` すると、
  board のタブに再送信の確認 (`chrome://global/content/commonDialog.xhtml`) が出て、
  サーバーへの要求は出ない (下の表)。間隔ごとに確認が出るうえ、「再送信」を押せば注文などの
  送信を繰り返しかねない。board が `webRequest.onBeforeRequest` (`sub_frame`) で枠の文書の
  要求の `method` を覚え、`onCommitted` で同じ URL (`#` 以降を除く) なら `p.posted` にする。
  転送 (POST → 303 → GET) なら転送先の要求で上書きされる。戻る・進むでキャッシュから出た
  ページは要求が無いので POST ではないとみなす (確認が出ることはありうる)。
- 枠を × で閉じると間隔も 0 に戻す (次に入れるサイトに持ち越さない)。
- 狭い枠 (`.narrow`) では見出しの間隔の文字 (`.auto-text`) を隠し、⏱ の色だけにする。
  横 4 分割 (枠の幅 269px) で「⏱1分30秒」が見出しからはみ出したため。

倍率と自動の再読み込みのダイアログは、開く・閉じる (外を押す・`blur`・Esc・× ・同じボタン) を
`openPopup` / `closePopup` で共用する。

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
| 題名: 枠 1 が nikkei225jp | `narabee(225先物 CME SGX 大取 夜間 リアルタイム チャート)` |
| 題名: 2.5 秒後に題名を変えるページ | 1.5 秒で `narabee(はじめの題名)`、4.5 秒で `narabee(あとの題名)` |
| 題名: 枠 1 を × で閉じる | `narabee` |
| ウィンドウ 2 でボタン (初回) | ウィンドウ 2 に `?b=` 付きの board が開き帯が出る。ウィンドウ 1 の帯は隠れたまま |
| ウィンドウ 2 で「枠 2 に送る」 / ウィンドウ 1 でボタン | ウィンドウ 2 の枠 2 だけに入る / ウィンドウ 1 の帯だけが出る |
| 保存先 / ウィンドウ 2 の board を読み直す | `state` と `state:<識別子>` に分かれる / 自分の内容で戻る |
| v10: board のあるウィンドウでボタン | board が 1 つ増え、新しい方だけ帯が出る |
| v10: 「枠に送る」 | そのウィンドウで最後に使っていた board に入る |
| v10: 3 つ (中身あり 2・空 1) を閉じてボタン | 中身のある 2 つだけ復元、最後に使っていた方が前面。空の保存は消えている |
| v10: 別のウィンドウでボタン (閉じた board なし) | 新しく 1 つ開く |
| v10: タブの右クリック「レイアウトバーを表示」と同じ処理 | その board だけ帯が出る |
| v11: 倍率を押す | ダイアログが開き、入力欄に今の値 (100)、焦点は入力欄 |
| v11: 85 でセット / 1000 や abc でセット | 85% になり閉じる / 反映せずエラーを出して開いたまま |
| v11: 値を変えて × / 外を押す / Esc / 枠の中を押す (blur) | どれも反映せずに閉じる |
| v11: リセット / 同じボタンをもう一度 | 100% にして閉じる / 閉じる |
| v11: 本物のキー入力で 75 → Enter (board を Web ページとして開いた写し) | 入力中は 100% のまま、Enter で 75% になり閉じる |
| v5 で nikkei225jp / 楽天の公開ページ / YouTube | 固まらず表示 (`parent` は元のまま) |
| v12 帯 (Firefox 158): ボタンで新しく開く / board を読み直す | 出る / 出ない |
| v12 帯: 右クリック「表示」/ × / 表示してレイアウトを選ぶ / 表示して 13 秒・16 秒 | 出る / 隠れる / 隠れる / 出ている・隠れる |
| v12 帯: board があるウィンドウでボタン (1 つ足す) | 足した方だけ出る |
| v12 帯: 破棄した board で右クリック「表示」 / それを読み直す | 出る / 出ない (破棄の扱いを外したビルドでは「表示」しても出なかった) |
| v12 帯: board を全部閉じてボタン (復元) | 復元した board に出る |
| 枠の中で POST の結果を `location.reload()` (v11 の ↻ と同じ) | 要求は出ず、board のタブに再送信の確認 (commonDialog) が 1 つ開く |
| v12 自動: 20 秒間の読み込み回数 (3 秒 / なし / 5 秒 / 応答に 4 秒かかるページを 2 秒) | 6 / 0 / 4 / 3 (遅いページは途中で切られない) |
| v12 自動: 1234 までスクロールした枠が読み直された後 | 1234 のまま |
| v12 自動: 0 分 60 秒 / 1x 分でセット | 反映せず「秒は 0〜59」「分は 0〜1440」を出して開いたまま |
| v12 自動: Esc / 空欄の分と 4 秒でセット / 23 分 / 更新なし | 反映せず閉じる / ⏱4秒 / ⏱23分 (保存 1380) / ⏱ (保存 0) |
| v12 自動: board を読み直す / その後 9 秒の 4 秒間隔 | 見出しの間隔が戻る / 2 回 |
| v12 自動: board を裏のタブにして 13 秒の 4 秒間隔 | 3 回 |
| v12 自動: 枠の入力欄に焦点を置いて文字を入れ 9 秒 | 0 回、文字は残る |
| v12 自動: 3 秒間隔の枠で POST、10 秒 | POST の再送 0、確認 0、見出しに取り消し線。GET のページへ移ると再開 (7 秒で 2 回) |
| v12 自動: 枠を × | 間隔が 0 になる |
| v12 倍率のダイアログ (共用化の後) | v11 の表と同じ結果 |
| v12 署名済み XPI を正式に入れ、枠 1 を 10 秒にして Firefox を終了 → 起動してボタン | 復元した board の見出しが ⏱10秒、21 秒で 2 回読み直す。その board を読み直すと帯は出ない |

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

### 枠ごとに別のコンテナ (Multi-Account Containers) で開く (見送り)

「メールなどをアカウントごとにコンテナで分けているので、枠ごとに別のコンテナで開きたい」と
要望を受けた (2026-10-15)。Firefox 158 で実測した結果、枠ごとにはできない。

| 確かめたこと | 結果 |
| --- | --- |
| board を `tabs.create({ cookieStoreId: 'firefox-container-1' })` で開く | 開ける (タブの `cookieStoreId` は `firefox-container-1`) |
| その board の枠 2 つ | どちらも container-1 のクッキー (送信・`document.cookie`) と localStorage を使う |
| 普通の board の枠 | container-1 のクッキー・localStorage は見えない |
| 枠 (iframe) ごとにコンテナを指定する API | 無い。コンテナはタブ全体に付く |
| `tabs.update(id, { cookieStoreId })` | `Unexpected property "cookieStoreId"` (作った後は変えられない) |

webRequest でクッキーの送受信だけを枠ごとに差し替える擬似コンテナはありうるが、
localStorage・IndexedDB・Service Worker・`document.cookie` は分けられず、セキュリティの
ためという目的に合わないので採らなかった。board 単位でコンテナを選ぶ案 (その board の枠は
すべてそのコンテナ。ログイン用のタブや復元も同じコンテナで開く必要がある) も示したが、
利用者の判断で見送った。

なお Firefox 158 は 2 つのタブを 1 つのウィンドウに並べる Split View を既定で有効にしている
(`browser.tabs.splitView.enabled` が true、タブの右クリックに「分割ビュー」系の項目)。
コンテナの違うタブ同士を並べられるかは確かめていない。

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
