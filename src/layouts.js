/**
 * レイアウトの定義と、枠・境目の位置の計算。
 *
 * レイアウトは分割の木で表す。葉は枠の番号 (0 始まり)、節は
 *   { d: 'row' | 'col', c: [子, ...] }
 * で、row は横に並べる (左右に分ける)、col は縦に積む (上下に分ける)。
 * 2-1 のような組み合わせも、木を入れ子にすれば書ける。
 */
var NarabeeLayouts = (() => {
  const row = (...c) => ({ d: 'row', c });
  const col = (...c) => ({ d: 'col', c });

  const LIST = [
    { id: 'one', name: '1 つだけ', tree: 0 },
    { id: 'h2', name: '左右に 2 つ', tree: row(0, 1) },
    { id: 'v2', name: '上下に 2 つ', tree: col(0, 1) },
    { id: 'h3', name: '横に 3 つ', tree: row(0, 1, 2) },
    { id: 'v3', name: '縦に 3 つ', tree: col(0, 1, 2) },
    { id: 'l1r2', name: '左 1・右 2', tree: row(0, col(1, 2)) },
    { id: 'l2r1', name: '左 2・右 1', tree: row(col(0, 1), 2) },
    { id: 't1b2', name: '上 1・下 2', tree: col(0, row(1, 2)) },
    { id: 't2b1', name: '上 2・下 1', tree: col(row(0, 1), 2) },
    { id: 'h4', name: '横に 4 つ', tree: row(0, 1, 2, 3) },
    { id: 'v4', name: '縦に 4 つ', tree: col(0, 1, 2, 3) },
    { id: 'g22', name: '2×2', tree: col(row(0, 1), row(2, 3)) },
    { id: 'l1r3', name: '左 1・右 3', tree: row(0, col(1, 2, 3)) },
    { id: 't1b3', name: '上 1・下 3', tree: col(0, row(1, 2, 3)) },
  ];

  const byId = new Map(LIST.map((l) => [l.id, l]));

  function get(id) {
    return byId.get(id) || byId.get('g22');
  }

  function count(tree) {
    return typeof tree === 'number' ? 1 : tree.c.reduce((n, c) => n + count(c), 0);
  }

  /** 保存された比率が使えなければ等分にする。 */
  function fractions(saved, n) {
    if (Array.isArray(saved) && saved.length === n && saved.every((x) => typeof x === 'number' && x > 0)) {
      const sum = saved.reduce((a, b) => a + b, 0);
      return saved.map((x) => x / sum);
    }
    return Array.from({ length: n }, () => 1 / n);
  }

  /**
   * 木をたどって、枠と境目の位置を 0〜1 の比率で返す。
   *   panes:    [{ index, x, y, w, h }]
   *   dividers: [{ path, k, d, x, y, w, h, node }]  k 番目と k+1 番目の子の境目
   * node は境目をドラッグしたときに使う、その節の領域。
   */
  function compute(tree, sizes) {
    const panes = [];
    const dividers = [];
    function walk(t, path, x, y, w, h) {
      if (typeof t === 'number') {
        panes.push({ index: t, x, y, w, h });
        return;
      }
      const fr = fractions(sizes && sizes[path], t.c.length);
      let offset = 0;
      t.c.forEach((child, k) => {
        const f = fr[k];
        if (t.d === 'row') walk(child, path + '.' + k, x + w * offset, y, w * f, h);
        else walk(child, path + '.' + k, x, y + h * offset, w, h * f);
        offset += f;
        if (k < t.c.length - 1) {
          const node = { x, y, w, h };
          if (t.d === 'row') dividers.push({ path, k, d: 'row', x: x + w * offset, y, w: 0, h, node });
          else dividers.push({ path, k, d: 'col', x, y: y + h * offset, w, h: 0, node });
        }
      });
    }
    walk(tree, 'r', 0, 0, 1, 1);
    return { panes, dividers };
  }

  return { LIST, get, count, fractions, compute };
})();
