/**
 * 保存する状態の形と、読み書き。背景と board の両方から読み込む。
 *
 * MV2 の背景は全スクリプトを同じグローバルで読むので、
 * ここから外へ出す名前は NarabeeState だけにする。
 */
var NarabeeState = (() => {
  const KEY = 'state';
  const MAX_PANES = 4;

  function blank() {
    return {
      v: 1,
      layout: 'g22',
      /** sizes[レイアウトID][分割の経路] = 子の比率 (合計 1) */
      sizes: {},
      /** scroll は board を読み直したときに戻すスクロール位置 ({ url, x, y } か null) */
      panes: Array.from({ length: MAX_PANES }, () => ({ url: '', zoom: 1, scroll: null })),
    };
  }

  /** 古い形や壊れた値が入っていても、足りないところを既定値で埋める。 */
  function normalize(raw) {
    const s = blank();
    if (!raw || typeof raw !== 'object') return s;
    if (typeof raw.layout === 'string') s.layout = raw.layout;
    if (raw.sizes && typeof raw.sizes === 'object') s.sizes = raw.sizes;
    if (Array.isArray(raw.panes)) {
      for (let i = 0; i < MAX_PANES; i += 1) {
        const p = raw.panes[i];
        if (!p) continue;
        if (typeof p.url === 'string') s.panes[i].url = p.url;
        if (typeof p.zoom === 'number' && p.zoom > 0) s.panes[i].zoom = p.zoom;
        const sc = p.scroll;
        if (sc && typeof sc.url === 'string' && Number.isFinite(sc.x) && Number.isFinite(sc.y)) {
          s.panes[i].scroll = { url: sc.url, x: sc.x, y: sc.y };
        }
      }
    }
    return s;
  }

  /**
   * board ごとの保存先。ウィンドウごとに別の board を開けるよう、board の URL に
   * ?b=<識別子> を付けて区別する。識別子の無い board (v8 までに開いたもの) は
   * これまでどおり 'state' を使う。
   */
  function keyFor(boardId) {
    return boardId ? KEY + ':' + boardId : KEY;
  }

  async function load(boardId) {
    const key = keyFor(boardId);
    const got = await browser.storage.local.get(key);
    return normalize(got[key]);
  }

  function save(state, boardId) {
    return browser.storage.local.set({ [keyFor(boardId)]: state });
  }

  return { MAX_PANES, blank, normalize, load, save };
})();
