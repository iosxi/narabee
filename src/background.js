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

  // ---- 枠では受け付けないログイン画面は、普通のタブで開く -------------------
  //
  // Google のログイン画面は、枠の中から開くとサーバーが 401 を返す
  // (拒否ヘッダーではなく、サーバー側の判断なので外せない)。クッキーは
  // 普通のタブと共通なので、ログインだけ普通のタブで済ませれば枠にも効く。
  // 枠 (board の直下) がこうした画面へ移ろうとしたら取り消して新しいタブで開き、
  // ログインが済んで別のサイトに戻ったら、そのタブを閉じて行き先を枠に読み込む。

  const LOGIN_IN_TAB = [/^accounts\.google\.com$/];
  /** ログイン用に開いたタブ -> { boardTabId, frameId } */
  const loginTabs = new Map();

  function needsLoginTab(url) {
    try {
      const host = new URL(url).hostname;
      return LOGIN_IN_TAB.some((re) => re.test(host));
    } catch {
      return false;
    }
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.parentFrameId !== 0 || !boards.has(details.tabId) || !needsLoginTab(details.url)) return {};
      const { tabId, frameId, url } = details;
      browser.tabs.create({ url, openerTabId: tabId }).then((tab) => {
        loginTabs.set(tab.id, { boardTabId: tabId, frameId });
      });
      return { cancel: true };
    },
    { urls: ['<all_urls>'], types: ['sub_frame'] },
    ['blocking']
  );

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    const login = loginTabs.get(tabId);
    if (!login || change.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
    // accounts.google.com → accounts.youtube.com → www.youtube.com と渡るので、
    // accounts. で始まるホストにいる間はまだ途中とみなす
    if (/^accounts\./.test(new URL(tab.url).hostname)) return;
    loginTabs.delete(tabId);
    browser.runtime
      .sendMessage({ type: 'load-frame', tabId: login.boardTabId, frameId: login.frameId, url: tab.url })
      .catch(() => {});
    browser.tabs.update(login.boardTabId, { active: true }).catch(() => {});
    browser.tabs.remove(tabId).catch(() => {});
  });

  browser.tabs.onRemoved.addListener((tabId) => loginTabs.delete(tabId));

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

  // board はウィンドウごとに持つ。ツールバーのボタンや右クリックは、押したウィンドウの
  // board だけを相手にする (v8 までは最初に見つかった board を相手にしていたので、
  // ウィンドウ 2 で押すとウィンドウ 1 の board に帯が出ていた)。

  /** そのウィンドウにある board のタブ。無ければ null。 */
  async function boardInWindow(windowId) {
    for (const tabId of boards) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (isBoardUrl(tab.url) && tab.windowId === windowId) return tab;
        if (!isBoardUrl(tab.url)) boards.delete(tabId);
      } catch {
        boards.delete(tabId);
      }
    }
    return null;
  }

  /** 新しい board の識別子 (board の URL の ?b=、保存先の区別に使う) */
  function newBoardId() {
    return crypto.randomUUID().slice(0, 8);
  }

  /**
   * そのウィンドウの board を前面に出す。無ければそのウィンドウに開く。
   * 開いたときは { tab, created: true, boardId }。
   */
  async function showBoard(windowId) {
    const tab = await boardInWindow(windowId);
    if (tab) {
      await browser.tabs.update(tab.id, { active: true });
      return { tab, created: false };
    }
    const boardId = newBoardId();
    const created = await browser.tabs.create({ url: BOARD_URL + '?b=' + boardId, windowId, active: true });
    return { tab: created, created: true, boardId };
  }

  /** ツールバーのボタン: そのウィンドウの board を前面に出し (無ければ開き)、上の帯を出す。 */
  async function onToolbarClick(windowId) {
    const { tab, created } = await showBoard(windowId);
    // 開いたばかりの board は自分で帯を出す
    if (!created) browser.runtime.sendMessage({ type: 'show-bar', tabId: tab.id }).catch(() => {});
  }

  browser.browserAction.onClicked.addListener((tab) => onToolbarClick(tab.windowId));

  // 動作テスト (tools/test-open.js) からツールバーのボタンと同じ処理を呼ぶための口
  globalThis.narabeeToolbarClick = onToolbarClick;

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
    await sendToPane(index, url, tab ? tab.windowId : browser.windows.WINDOW_ID_CURRENT);
  });

  /**
   * そのウィンドウの board に読み込ませる (状態の持ち主は board)。
   * board が無ければ、新しい board の保存先に書いてから開く。
   */
  async function sendToPane(index, url, windowId) {
    const existing = await boardInWindow(windowId);
    if (existing) {
      await browser.runtime.sendMessage({ type: 'load', tabId: existing.id, index, url }).catch(() => {});
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
    const boardId = newBoardId();
    const state = NarabeeState.blank();
    state.panes[index].url = url;
    if (index > 1) state.layout = index === 2 ? 'h3' : 'g22';
    else state.layout = index === 1 ? 'h2' : 'one';
    await NarabeeState.save(state, boardId);
    await browser.tabs.create({ url: BOARD_URL + '?b=' + boardId, windowId, active: true });
  }

  // 動作テスト (tools/test-open.js) から右クリックの「枠に送る」と同じ処理を呼ぶための口
  globalThis.narabeeSendToPane = sendToPane;
})();
