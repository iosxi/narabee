(() => {
  const BASE = browser.runtime.getURL('');
  const BOARD_URL = browser.runtime.getURL('src/board.html');

  /** 開いている board のタブ。board が読み込まれたときに自分で名乗り出る。 */
  const boards = new Set();

  function isBoardUrl(url) {
    return typeof url === 'string' && url.startsWith(BOARD_URL);
  }

  // ---- 埋め込み拒否を外す ----------------------------------------------
  //
  // board の中に読み込まれる枠 (とその中の枠) に限り、X-Frame-Options と
  // CSP の frame-ancestors を取り除く。普通のタブで開いたページには触らない。
  // frame-ancestors は祖先を全部たどって判定されるので、枠の中のサイトが
  // 自分で埋め込んでいる iframe も、祖先に board がいると拒否される。
  // そのため直下の枠だけでなく、祖先に board がいる枠はすべて対象にする。

  function underBoard(details) {
    const anc = details.frameAncestors;
    return Array.isArray(anc) && anc.some((a) => a && typeof a.url === 'string' && a.url.startsWith(BASE));
  }

  // サイトが Service Worker を持っていると、枠の読み込みは Service Worker に
  // 振り替えられ、Service Worker が同じ URL を取り直す。その応答には
  // frameAncestors もタブも付かない (tabId -1) ので、上の判定では拾えない。
  // YouTube がこれで、一度でも普通のタブで開いていると枠に入らなくなっていた。
  // board の枠が読み込み始めた URL を少しの間だけ覚え、同じサイトの
  // Service Worker が同じ URL を取りに来たら、それも board の枠向けとみなす。
  const SW_WINDOW_MS = 30000;
  const swExpected = new Map(); // URL -> 期限

  function expectServiceWorker(url) {
    const now = Date.now();
    for (const [u, until] of swExpected) if (until < now) swExpected.delete(u);
    swExpected.set(url, now + SW_WINDOW_MS);
  }

  function fromServiceWorkerForBoard(details) {
    if (details.tabId !== -1) return false;
    const until = swExpected.get(details.url);
    if (!until || until < Date.now()) return false;
    try {
      if (new URL(details.originUrl).origin !== new URL(details.url).origin) return false;
    } catch {
      return false;
    }
    swExpected.delete(details.url);
    return true;
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (underBoard(details)) expectServiceWorker(details.url);
    },
    { urls: ['<all_urls>'], types: ['sub_frame'] }
  );
  browser.webRequest.onBeforeRedirect.addListener(
    (details) => {
      if (underBoard(details)) expectServiceWorker(details.redirectUrl);
    },
    { urls: ['<all_urls>'], types: ['sub_frame'] }
  );

  function stripFrameAncestors(csp) {
    return csp
      .split(';')
      .filter((part) => !/^\s*frame-ancestors(\s|$)/i.test(part))
      .join(';');
  }

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!underBoard(details) && !fromServiceWorkerForBoard(details)) return {};
      const out = [];
      let changed = false;
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'x-frame-options') {
          changed = true;
          continue;
        }
        if (name === 'content-security-policy' && typeof h.value === 'string') {
          const v = stripFrameAncestors(h.value);
          if (v !== h.value) {
            changed = true;
            if (v.trim()) out.push({ name: h.name, value: v });
            continue;
          }
        }
        out.push(h);
      }
      return changed ? { responseHeaders: out } : {};
    },
    { urls: ['<all_urls>'], types: ['sub_frame'] },
    ['blocking', 'responseHeaders']
  );

  // ---- 枠の中のリンクが board ごと置き換えるのを防ぐ ----------------------
  //
  // target="_top" のリンクは、枠ではなくタブ全体を移動させてしまう。
  // board の枠には frame.js を差し込み、そうしたリンクを枠の中で開かせる。
  // frame.js でも拾えなかったもの (スクリプトからの遷移など) は、下の
  // onBeforeRequest で止めて board に回す。

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0 || !boards.has(details.tabId)) return;
    if (!/^https?:/.test(details.url)) return;
    browser.tabs
      .executeScript(details.tabId, { frameId: details.frameId, file: '/src/frame.js', runAt: 'document_start' })
      .catch(() => {});
  });

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!boards.has(details.tabId)) return {};
      // アドレスバーへの入力などは originUrl が無いか、Web のページではない。
      // Web のページが始めたタブ全体の移動だけを、枠の中から来たものとみなす。
      if (!details.originUrl || !/^https?:/.test(details.originUrl)) return {};
      browser.runtime
        .sendMessage({ type: 'escape', tabId: details.tabId, url: details.url, originUrl: details.originUrl })
        .catch(() => {});
      return { cancel: true };
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['blocking']
  );

  // ---- board のタブの管理 ----------------------------------------------

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'board-hello' && sender.tab) {
      boards.add(sender.tab.id);
      return Promise.resolve({ tabId: sender.tab.id });
    }
    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => boards.delete(tabId));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !isBoardUrl(change.url)) boards.delete(tabId);
  });

  /** 開いている board があれば前面に出し、無ければ開く。 */
  async function showBoard() {
    for (const tabId of boards) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (!isBoardUrl(tab.url)) continue;
        await browser.tabs.update(tabId, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
        return tab;
      } catch {
        boards.delete(tabId);
      }
    }
    return browser.tabs.create({ url: BOARD_URL });
  }

  browser.browserAction.onClicked.addListener(() => {
    showBoard();
  });

  // ---- 右クリックで枠に送る --------------------------------------------

  const MENU_PAGE = 'send-page';
  const MENU_LINK = 'send-link';

  function buildMenus() {
    browser.menus.removeAll().then(() => {
      browser.menus.create({
        id: MENU_PAGE,
        title: 'このページを narabee の枠に送る',
        contexts: ['page', 'tab'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
      browser.menus.create({
        id: MENU_LINK,
        title: 'リンクを narabee の枠で開く',
        contexts: ['link'],
      });
      for (let i = 0; i < NarabeeState.MAX_PANES; i += 1) {
        for (const parentId of [MENU_PAGE, MENU_LINK]) {
          browser.menus.create({ id: parentId + ':' + i, parentId, title: '枠 ' + (i + 1), contexts: ['all', 'tab'] });
        }
      }
    });
  }

  browser.runtime.onInstalled.addListener(buildMenus);
  browser.runtime.onStartup.addListener(buildMenus);

  browser.menus.onClicked.addListener(async (info, tab) => {
    const [parentId, idx] = String(info.menuItemId).split(':');
    const index = Number(idx);
    if (!Number.isInteger(index)) return;
    const url = parentId === MENU_LINK ? info.linkUrl : (tab && tab.url) || info.pageUrl;
    if (!url || !/^https?:/.test(url)) return;
    await sendToPane(index, url);
  });

  /**
   * board が開いていれば board に読み込ませる (状態の持ち主は board)。
   * 開いていなければ保存してから board を開く。
   */
  async function sendToPane(index, url) {
    let delivered = false;
    if (boards.size > 0) {
      try {
        const r = await browser.runtime.sendMessage({ type: 'load', index, url });
        delivered = !!(r && r.ok);
      } catch {
        delivered = false;
      }
    }
    if (!delivered) {
      const state = await NarabeeState.load();
      state.panes[index].url = url;
      await NarabeeState.save(state);
    }
    await showBoard();
  }
})();
