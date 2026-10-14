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
