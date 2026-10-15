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
      /**
       * order[置き場所] = その置き場所に出す枠 (panes の添字)。番号 (①〜④) や「枠に送る」の
       * 枠 N は置き場所で数える。枠の入れ替えは、iframe を読み込み直さないよう、ここだけを変える。
       */
      order: Array.from({ length: MAX_PANES }, (_, i) => i),
      /**
       * scroll は board を読み直したときに戻すスクロール位置 ({ url, x, y } か null)。
       * reload は自動で再読み込みする間隔 (秒)。0 は自動では読み直さない。
       */
      panes: Array.from({ length: MAX_PANES }, () => ({ url: '', zoom: 1, scroll: null, reload: 0 })),
    };
  }

  /** 古い形や壊れた値が入っていても、足りないところを既定値で埋める。 */
  function normalize(raw) {
    const s = blank();
    if (!raw || typeof raw !== 'object') return s;
    if (typeof raw.layout === 'string') s.layout = raw.layout;
    if (Number.isFinite(raw.updatedAt)) s.updatedAt = raw.updatedAt;
    if (raw.sizes && typeof raw.sizes === 'object') s.sizes = raw.sizes;
    if (Array.isArray(raw.order) && raw.order.length === MAX_PANES && [...raw.order].sort().every((v, i) => v === i)) {
      s.order = raw.order.slice();
    }
    if (Array.isArray(raw.panes)) {
      for (let i = 0; i < MAX_PANES; i += 1) {
        const p = raw.panes[i];
        if (!p) continue;
        if (typeof p.url === 'string') s.panes[i].url = p.url;
        if (typeof p.zoom === 'number' && p.zoom > 0) s.panes[i].zoom = p.zoom;
        if (Number.isInteger(p.reload) && p.reload > 0) s.panes[i].reload = p.reload;
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
    // 閉じた board を復元するとき、古いものから順に並べるのに使う
    state.updatedAt = Date.now();
    return browser.storage.local.set({ [keyFor(boardId)]: state });
  }

  /** 保存されている board の一覧 [{ id, state }] (id は識別子。v8 までの board は '') */
  async function list() {
    const all = await browser.storage.local.get(null);
    const out = [];
    for (const [key, value] of Object.entries(all)) {
      if (key === KEY) out.push({ id: '', state: normalize(value) });
      else if (key.startsWith(KEY + ':')) out.push({ id: key.slice(KEY.length + 1), state: normalize(value) });
    }
    return out;
  }

  function remove(boardId) {
    return browser.storage.local.remove(keyFor(boardId));
  }

  /** 枠に何か入っているか (空の board は閉じても復元の対象にしない) */
  function hasContent(state) {
    return state.panes.some((p) => p.url);
  }

  return { MAX_PANES, blank, normalize, load, save, list, remove, hasContent };
})();
