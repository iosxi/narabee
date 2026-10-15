/**
 * board の枠の中に差し込むスクリプト (background.js が executeScript で入れる)。
 *
 * target="_top" / "_parent" のリンクとフォームは、そのままだと board の
 * タブごと移動してしまう。board の直下の枠でだけ、枠の中で開くように直す。
 *
 * 送信の瞬間 (submit イベント) に直すのでは足りない。楽天証券のログインボタンは
 * onclick で document.loginform.submit() を呼び、スクリプトからの submit() は
 * submit イベントを出さない。_top のまま POST がタブ全体に出て、背景の見張りが
 * 枠に読み直すと本文 (ID・パスワード) が落ちて GET になり、ログインエラーになっていた。
 * そこで属性そのものを、現れた時点で書き換えておく。
 * 同じ枠に何度差し込まれても、処理は一度だけ登録する。
 */
(() => {
  if (window.__narabeeFrame) return;
  window.__narabeeFrame = true;
  if (window === window.top) return;

  // YouTube のチャット欄 (watch ページの中の live_chat の iframe) は、× などの合図を
  // window.top.postMessage(合図, POST_TO_PARENT_DOMAIN = 'https://www.youtube.com') で
  // watch ページに送る。枠の中では top が board なので宛先の origin が合わず、Firefox が
  // 捨てていた (× を押しても欄が畳まれない)。宛先を board の origin に変えて board に
  // 届かせ、board が枠の watch ページに渡し直す (下の relay-message)。
  if (window.parent !== window.top) {
    if (location.origin === 'https://www.youtube.com' && location.pathname.startsWith('/live_chat')) {
      const boardOrigin = new URL(browser.runtime.getURL('')).origin;
      const retarget = () => {
        const yt = window.wrappedJSObject.yt;
        if (yt && yt.config_) yt.config_.POST_TO_PARENT_DOMAIN = boardOrigin;
      };
      retarget();
      document.addEventListener('DOMContentLoaded', retarget, { once: true });
      window.addEventListener('load', retarget, { once: true });
    }
    // ほかは board の直下の枠だけ。もっと深い枠の _parent は親の枠を指すので正しい。
    return;
  }

  // board から: 子の iframe (window.frames[index]) が top に送った合図を、普通のタブで
  // top だったこのページに届け直す。YouTube は送り主 (source) がチャット欄であることを
  // 確かめるので、source を付ける (付けないと無視された)。
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'relay-message') return undefined;
    const page = window.wrappedJSObject;
    const source = page.frames[msg.index];
    if (!source) return undefined;
    window.dispatchEvent(new MessageEvent('message', { data: cloneInto(msg.data, page), origin: msg.origin, source }));
    return undefined;
  });

  // 楽天証券の会員ページのメニュー (125 個) は onclick で memberPageJump() を呼ぶ。
  // memberPageJump() は typeof parent.IFAWebMain を調べるが、枠の parent は
  // board (拡張機能のページ) なので SecurityError になり、それを catch で
  // 握りつぶすため、押しても何も起きなかった。
  // memberPageJump() を呼んでいる間だけ、ページから見た parent を自分自身にする
  // (普通のタブで開いたときと同じ)。すると最後の top.location.href に進み、
  // 背景の見張りが枠の中の移動に振り替える。
  // parent を常に差し替えるのは駄目だった。top は差し替えられないので、
  // 「parent をたどって top に着くまで」の処理が終わらなくなり、nikkei225jp や
  // 楽天の公開ページの枠が固まった。
  const page = window.wrappedJSObject;
  const JUMPS = ['memberPageJump'];
  // 包み済みの目印。拡張機能側とページ側では同じ関数でも別のオブジェクトに
  // 見えるので WeakSet では判定できず、クリックのたびに包み直していた。
  const MARK = '__narabeeWrapped';

  function withParentIsSelf(fn, self, args) {
    const saved = Object.getOwnPropertyDescriptor(page, 'parent');
    try {
      Object.defineProperty(page, 'parent', { value: page, configurable: true, writable: true });
    } catch {
      return fn.call(self, ...args);
    }
    try {
      return fn.call(self, ...args);
    } finally {
      if (saved) Object.defineProperty(page, 'parent', saved);
    }
  }

  function wrapJumps() {
    for (const name of JUMPS) {
      const fn = page[name];
      if (typeof fn !== 'function' || fn[MARK]) continue;
      const replacement = exportFunction(function (...args) {
        return withParentIsSelf(fn, this, args);
      }, page);
      page[name] = replacement;
      page[name][MARK] = true;
    }
  }

  // 差し替えはクリックの直前に行う (ページの onclick より先に動く捕捉段階)。
  // 読み込みの途中に定義される関数も、これなら取りこぼさない。
  document.addEventListener('click', wrapJumps, true);

  // スクロール位置を board に知らせる。board を読み直したとき (と次に開いたとき) に
  // 枠のページは保存した URL から読み込み直されるので、普通のタブのような位置の
  // 復元が効かない。board が位置を覚えておき、読み込み後に戻す。
  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        browser.runtime
          .sendMessage({ type: 'frame-scroll', url: location.href, x: Math.round(window.scrollX), y: Math.round(window.scrollY) })
          .catch(() => {});
      }, 250);
    },
    { passive: true }
  );

  // ページの題名を board に知らせる。board は枠 1 の題名をタブ (ウィンドウ) の題名に使う。
  // 題名は後から変わることがある (ni225simple が設定を付け足すなど) ので、1 秒ごとに見る。
  let lastTitle = null;
  function reportTitle() {
    const title = document.title;
    if (title === lastTitle) return;
    lastTitle = title;
    browser.runtime.sendMessage({ type: 'frame-title', title }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportTitle, { once: true });
  else reportTitle();
  setInterval(reportTitle, 1000);

  const ESCAPING = /^_(top|parent)$/i;
  const ATTRS = ['target', 'formtarget'];
  const SELECTOR = 'a[target], area[target], form[target], base[target], button[formtarget], input[formtarget]';

  function fix(el) {
    for (const name of ATTRS) {
      const v = el.getAttribute(name);
      if (v !== null && ESCAPING.test(v.trim())) el.setAttribute(name, '_self');
    }
  }

  function fixTree(node) {
    if (!(node instanceof Element)) return;
    if (node.matches(SELECTOR)) fix(node);
    for (const el of node.querySelectorAll(SELECTOR)) fix(el);
  }

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') fix(r.target);
      else for (const n of r.addedNodes) fixTree(n);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS });

  if (document.documentElement) fixTree(document.documentElement);
})();
