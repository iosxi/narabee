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
  //
  // board は 1 つのウィンドウに幾つでも開ける。board ごとに識別子 (URL の ?b=) を持ち、
  // 保存先も別 (state:<識別子>。v8 までに開いた識別子の無い board は state)。

  /** 読み込まれた board のタブ ID -> 識別子 (board が自分で名乗り出る) */
  const boardIds = new Map();

  function boardIdOf(url) {
    try {
      return new URL(url).searchParams.get('b') || '';
    } catch {
      return '';
    }
  }

  function boardUrl(boardId) {
    return boardId ? BOARD_URL + '?b=' + boardId : BOARD_URL;
  }

  /**
   * 次に読み込まれたときに帯を出す board の識別子。帯を出すのは、ツールバーのボタンや
   * 「枠に送る」で board のタブを足したときと、まだ読み込まれていない board で
   * 「レイアウトバーを表示」を選んだときだけ。board を読み直したとき (F5 や、
   * Firefox の再起動でタブが戻ったとき) は出さない。
   */
  const showBarOnHello = new Set();

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'board-hello' && sender.tab) {
      const boardId = boardIdOf(sender.url || sender.tab.url);
      boards.add(sender.tab.id);
      boardIds.set(sender.tab.id, boardId);
      return Promise.resolve({ tabId: sender.tab.id, showBar: showBarOnHello.delete(boardId) });
    }
    return undefined;
  });

  // board のタブを閉じたとき、枠が全部空なら保存内容を捨てる (復元の対象にしない)。
  // ウィンドウごと閉じたときは、Firefox のセッション復元で戻ることがあるので残す。
  browser.tabs.onRemoved.addListener(async (tabId, info) => {
    boards.delete(tabId);
    if (!boardIds.has(tabId)) return;
    const boardId = boardIds.get(tabId);
    boardIds.delete(tabId);
    if (info && info.isWindowClosing) return;
    // board が閉じる直前の保存を待つ
    await new Promise((r) => setTimeout(r, 500));
    const state = await NarabeeState.load(boardId);
    if (!NarabeeState.hasContent(state)) await NarabeeState.remove(boardId);
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url && !isBoardUrl(change.url)) {
      boards.delete(tabId);
      boardIds.delete(tabId);
    }
    // 破棄されたタブ (メモリ節約で中身を捨てたタブ) の board は、前面に出ると読み込み直して
    // 名乗り出る。それまでは読み込まれていない board として扱う (指示を送っても届かない)。
    // boardIds は閉じたときの後始末に使うので残す。
    if (change.discarded === true) boards.delete(tabId);
  });

  /**
   * 開いている board のタブ (すべてのウィンドウ)。読み込まれていないタブ (再起動後に
   * まだ選ばれていないタブ) も URL で数える。
   */
  async function openBoardTabs() {
    const tabs = await browser.tabs.query({});
    return tabs.filter((t) => isBoardUrl(t.url));
  }

  /** 新しい board の識別子 (board の URL の ?b=、保存先の区別に使う) */
  function newBoardId() {
    return crypto.randomUUID().slice(0, 8);
  }

  /** board のタブを足す。足した board は、読み込まれたときに帯を出す。 */
  function createBoard(windowId, boardId = newBoardId(), active = true) {
    showBarOnHello.add(boardId);
    return browser.tabs.create({ url: boardUrl(boardId), windowId, active });
  }

  /**
   * ツールバーのボタン。
   * - そのウィンドウに board があれば、board を 1 つ足す。
   * - 無ければ、閉じた board (どのウィンドウにも開いていない、枠に何か入っているもの) を
   *   すべてそのウィンドウに復元する。復元するものが無ければ新しく開く。
   * 帯は足した board が読み込まれたときに出す (createBoard)。
   */
  async function onToolbarClick(windowId) {
    const open = await openBoardTabs();
    if (open.some((t) => t.windowId === windowId)) {
      await createBoard(windowId);
      return;
    }
    const openIds = new Set(open.map((t) => boardIdOf(t.url)));
    const closed = (await NarabeeState.list())
      .filter((b) => !openIds.has(b.id) && NarabeeState.hasContent(b.state))
      .sort((a, b) => (a.state.updatedAt || 0) - (b.state.updatedAt || 0));
    if (closed.length === 0) {
      await createBoard(windowId);
      return;
    }
    // 最後に使っていたものを前面にする
    for (let i = 0; i < closed.length; i += 1) {
      await createBoard(windowId, closed[i].id, i === closed.length - 1);
    }
  }

  browser.browserAction.onClicked.addListener((tab) => onToolbarClick(tab.windowId));

  // 動作テスト (tools/test-open.js) からツールバーのボタンと同じ処理を呼ぶための口
  globalThis.narabeeToolbarClick = onToolbarClick;

  /**
   * タブの右クリック「narabee レイアウトバーを表示」。board がまだ読み込まれていない
   * (再起動後に選ばれていない) タブは、前面に出すと読み込まれるので、そのとき帯を出す。
   */
  async function showBarOf(tabId) {
    if (!boards.has(tabId)) {
      const tab = await browser.tabs.get(tabId);
      showBarOnHello.add(boardIdOf(tab.url));
    }
    await browser.tabs.update(tabId, { active: true });
    if (boards.has(tabId)) browser.runtime.sendMessage({ type: 'show-bar', tabId }).catch(() => {});
  }

  globalThis.narabeeShowBar = showBarOf;

  // ---- 右クリックで枠に送る --------------------------------------------

  const MENU_PAGE = 'send-page';
  const MENU_LINK = 'send-link';
  const MENU_BAR = 'show-bar';

  function buildMenus() {
    browser.menus.removeAll().then(() => {
      browser.menus.create({
        id: MENU_PAGE,
        title: 'このページを narabee の枠に送る',
        contexts: ['page', 'tab'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
      // board のタブにだけ出す (onShown で切り替える)
      browser.menus.create({
        id: MENU_BAR,
        title: 'narabee レイアウトバーを表示',
        contexts: ['tab'],
        visible: false,
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

  browser.menus.onShown.addListener((info, tab) => {
    if (!info.contexts.includes('tab')) return;
    browser.menus.update(MENU_BAR, { visible: !!(tab && isBoardUrl(tab.url)) }).then(() => browser.menus.refresh());
  });

  browser.menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU_BAR) {
      if (tab && isBoardUrl(tab.url)) await showBarOf(tab.id);
      return;
    }
    const [parentId, idx] = String(info.menuItemId).split(':');
    const index = Number(idx);
    if (!Number.isInteger(index)) return;
    const url = parentId === MENU_LINK ? info.linkUrl : (tab && tab.url) || info.pageUrl;
    if (!url || !/^https?:/.test(url)) return;
    await sendToPane(index, url, tab ? tab.windowId : browser.windows.WINDOW_ID_CURRENT);
  });

  /**
   * そのウィンドウで最後に使っていた board に読み込ませる (状態の持ち主は board)。
   * board がまだ読み込まれていなければ保存先に書いてから前面に出し、
   * そのウィンドウに board が無ければ新しく開く。
   */
  async function sendToPane(index, url, windowId) {
    const inWindow = (await openBoardTabs()).filter((t) => t.windowId === windowId);
    inWindow.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const target = inWindow[0];
    if (target && boards.has(target.id)) {
      await browser.runtime.sendMessage({ type: 'load', tabId: target.id, index, url }).catch(() => {});
      await browser.tabs.update(target.id, { active: true });
      return;
    }
    const boardId = target ? boardIdOf(target.url) : newBoardId();
    const state = target ? await NarabeeState.load(boardId) : NarabeeState.blank();
    state.panes[index].url = url;
    if (!target) state.layout = ['one', 'h2', 'h3', 'g22'][index] || 'g22';
    await NarabeeState.save(state, boardId);
    if (target) await browser.tabs.update(target.id, { active: true });
    else await createBoard(windowId, boardId);
  }

  // 動作テスト (tools/test-open.js) から右クリックの「枠に送る」と同じ処理を呼ぶための口
  globalThis.narabeeSendToPane = sendToPane;
})();
