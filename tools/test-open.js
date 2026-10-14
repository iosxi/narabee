/**
 * 動作テスト用 (製品には含めない)。tools/make-test-build.js が背景に足す。
 *
 * WebDriver BiDi では moz-extension:// へ移れないので、Web のページ
 * .../open-board?state=<JSON> を開いたら、状態を保存してから board を開く。
 */
(() => {
  browser.webNavigation.onCompleted.addListener(async (d) => {
    if (d.frameId !== 0 || !d.url.includes('/open-board')) return;
    const st = new URL(d.url).searchParams.get('state');
    if (st) await NarabeeState.save(NarabeeState.normalize(JSON.parse(st)));
    browser.tabs.create({ url: browser.runtime.getURL('src/board.html') });
  });
})();

/** .../send-load?i=<枠>&url=<URL> を開くと、右クリックの「枠に送る」と同じ指示を board に送る。 */
(() => {
  browser.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId !== 0 || !d.url.includes('/send-load')) return;
    const q = new URL(d.url).searchParams;
    browser.runtime.sendMessage({ type: 'load', index: Number(q.get('i')), url: q.get('url') });
  });
})();

/** .../show-bar を開くと、ツールバーのボタンを押したときと同じ「帯を出す」指示を board に送る。 */
(() => {
  browser.webNavigation.onCompleted.addListener(async (d) => {
    if (d.frameId !== 0 || !d.url.includes('/show-bar')) return;
    const base = browser.runtime.getURL('src/board.html');
    for (const tab of await browser.tabs.query({})) {
      if (tab.url && tab.url.startsWith(base)) browser.runtime.sendMessage({ type: 'show-bar', tabId: tab.id });
    }
  });
})();

/**
 * .../toolbar を開くと、そのタブのウィンドウでツールバーのボタンを押したのと同じ処理を呼ぶ。
 * .../menu-send?i=<枠>&url=<URL> を開くと、そのウィンドウで右クリックの「枠に送る」と同じ処理を呼ぶ。
 */
(() => {
  browser.webNavigation.onCompleted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    const tab = await browser.tabs.get(d.tabId);
    if (d.url.includes('/toolbar')) globalThis.narabeeToolbarClick(tab.windowId);
    if (d.url.includes('/menu-send')) {
      const q = new URL(d.url).searchParams;
      globalThis.narabeeSendToPane(Number(q.get('i')), q.get('url'), tab.windowId);
    }
  });
})();

/** .../showbar-of?b=<識別子> を開くと、その board のタブで右クリック「narabee レイアウトバーを表示」と同じ処理を呼ぶ。 */
(() => {
  browser.webNavigation.onCompleted.addListener(async (d) => {
    if (d.frameId !== 0 || !d.url.includes('/showbar-of')) return;
    const id = new URL(d.url).searchParams.get('b') || '';
    const base = browser.runtime.getURL('src/board.html');
    for (const tab of await browser.tabs.query({})) {
      if (!tab.url || !tab.url.startsWith(base)) continue;
      if ((new URL(tab.url).searchParams.get('b') || '') === id) globalThis.narabeeShowBar(tab.id);
    }
  });
})();
