(() => {
  const stage = document.getElementById('stage');
  const layoutsEl = document.getElementById('layouts');
  const tpl = document.getElementById('pane-tpl');

  const ZOOM_STEPS = [0.3, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const MIN_PANE_PX = 80;
  /** 見出しのボタンを間引き始める枠の幅 */
  const NARROW_PX = 380;

  let state = NarabeeState.blank();
  let tabId = null;
  /** その枠だけを大きくしているときの枠の番号。していなければ null。 */
  let maxed = null;
  const panes = [];
  let dividerEls = [];

  // ---- 保存 -----------------------------------------------------------

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => NarabeeState.save(state), 300);
  }
  window.addEventListener('pagehide', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      NarabeeState.save(state);
    }
  });

  // ---- URL ------------------------------------------------------------

  /**
   * 入力欄の文字を URL にする。スキームが無ければ https:// を補い、
   * URL らしくなければ検索する。http(s) 以外のスキームは受け付けない。
   */
  function toUrl(text) {
    const t = text.trim();
    if (!t) return '';
    const hostPort = /^[^\s/:]+:\d+(\/|$)/.test(t); // localhost:8000 はスキームではない
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !hostPort) {
      return /^https?:\/\//i.test(t) ? t : '';
    }
    if (/\s/.test(t) || (!/[.:]/.test(t) && t !== 'localhost')) {
      return 'https://www.google.com/search?q=' + encodeURIComponent(t);
    }
    const local = /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(t);
    return (local ? 'http://' : 'https://') + t;
  }

  // ---- レイアウトの選択 -------------------------------------------------

  function buildLayoutButtons() {
    let lastCount = null;
    for (const layout of NarabeeLayouts.LIST) {
      const n = NarabeeLayouts.count(layout.tree);
      if (lastCount !== null && n !== lastCount) {
        const sep = document.createElement('span');
        sep.className = 'layout-sep';
        layoutsEl.append(sep);
      }
      lastCount = n;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layout-btn';
      btn.setAttribute('role', 'radio');
      btn.dataset.id = layout.id;
      btn.title = layout.name;
      btn.setAttribute('aria-label', layout.name);
      const mini = document.createElement('span');
      mini.className = 'mini';
      for (const r of NarabeeLayouts.compute(layout.tree, null).panes) {
        const i = document.createElement('i');
        i.style.left = `calc(${r.x * 100}% + 1px)`;
        i.style.top = `calc(${r.y * 100}% + 1px)`;
        i.style.width = `calc(${r.w * 100}% - 2px)`;
        i.style.height = `calc(${r.h * 100}% - 2px)`;
        mini.append(i);
      }
      btn.append(mini);
      btn.addEventListener('click', () => setLayout(layout.id));
      layoutsEl.append(btn);
    }
  }

  function setLayout(id) {
    state.layout = NarabeeLayouts.get(id).id;
    maxed = null;
    place();
    saveSoon();
  }

  // ---- 枠 ---------------------------------------------------------------

  function createPane(index) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const p = {
      index,
      el,
      iframe: el.querySelector('iframe'),
      input: el.querySelector('.url'),
      zoomBtn: el.querySelector('.zoom'),
      /** 枠の中で今表示している URL (webNavigation で追う) */
      current: '',
    };
    el.querySelector('.num').textContent = String(index + 1);

    el.querySelector('.go').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const url = toUrl(p.input.value);
      if (url) {
        loadPane(index, url);
        p.input.blur();
      } else {
        p.input.select();
      }
    });
    p.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        p.input.value = p.current;
        p.input.blur();
      }
    });
    p.input.addEventListener('focus', () => p.input.select());

    el.querySelector('header').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (btn) act(p, btn.dataset.act);
    });
    el.querySelector('header').addEventListener('dblclick', (ev) => {
      if (ev.target.closest('button, input')) return;
      toggleMax(index);
    });

    new ResizeObserver(() => {
      el.classList.toggle('narrow', el.clientWidth > 0 && el.clientWidth < NARROW_PX);
    }).observe(el);

    stage.append(el);
    return p;
  }

  function showUrl(p, url) {
    p.current = url;
    if (document.activeElement !== p.input) p.input.value = url;
    p.el.classList.toggle('is-empty', !url);
    p.input.title = url;
  }

  function loadPane(index, url) {
    const p = panes[index];
    state.panes[index].url = url;
    showUrl(p, url);
    p.iframe.src = url;
    saveSoon();
  }

  function applyZoom(p) {
    const z = state.panes[p.index].zoom;
    p.iframe.style.setProperty('--z', String(z));
    p.zoomBtn.textContent = Math.round(z * 100) + '%';
  }

  function stepZoom(p, dir) {
    const z = state.panes[p.index].zoom;
    let i = ZOOM_STEPS.findIndex((s) => s >= z - 1e-6);
    if (i < 0) i = ZOOM_STEPS.length - 1;
    if (dir > 0) i = ZOOM_STEPS[i] > z + 1e-6 ? i : i + 1;
    else i -= 1;
    i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i));
    state.panes[p.index].zoom = ZOOM_STEPS[i];
    applyZoom(p);
    saveSoon();
  }

  /** 枠の中の履歴を動かす。枠の中は別のサイトなので、差し込んだスクリプトで行う。 */
  async function runInFrame(p, code) {
    const frameId = browser.runtime.getFrameId(p.iframe);
    if (tabId === null || frameId < 0) return false;
    try {
      await browser.tabs.executeScript(tabId, { frameId, code });
      return true;
    } catch {
      return false;
    }
  }

  async function act(p, action) {
    switch (action) {
      case 'back':
        await runInFrame(p, 'history.back()');
        break;
      case 'forward':
        await runInFrame(p, 'history.forward()');
        break;
      case 'reload':
        // エラーページなどで差し込めないときは、覚えている URL を読み直す
        if (!(await runInFrame(p, 'location.reload()')) && p.current) p.iframe.src = p.current;
        break;
      case 'zoomin':
        stepZoom(p, 1);
        break;
      case 'zoomout':
        stepZoom(p, -1);
        break;
      case 'zoomreset':
        state.panes[p.index].zoom = 1;
        applyZoom(p);
        saveSoon();
        break;
      case 'max':
        toggleMax(p.index);
        break;
      case 'popout':
        if (p.current) browser.tabs.create({ url: p.current });
        break;
      default:
        break;
    }
  }

  function toggleMax(index) {
    maxed = maxed === index ? null : index;
    place();
  }

  // ---- 配置 -------------------------------------------------------------

  function setRect(el, r) {
    el.style.left = `calc(${r.x * 100}% + var(--gap))`;
    el.style.top = `calc(${r.y * 100}% + var(--gap))`;
    el.style.width = `calc(${r.w * 100}% - 2 * var(--gap))`;
    el.style.height = `calc(${r.h * 100}% - 2 * var(--gap))`;
  }

  /**
   * 枠と境目を置き直す。iframe は DOM 上で動かさない (動かすと読み込み直しになる)。
   * 使わない枠は隠すだけなので、レイアウトを戻せば中身もそのまま戻る。
   */
  function place() {
    const layout = NarabeeLayouts.get(state.layout);
    let { panes: rects, dividers } = NarabeeLayouts.compute(layout.tree, state.sizes[layout.id]);
    if (maxed !== null) {
      rects = [{ index: maxed, x: 0, y: 0, w: 1, h: 1 }];
      dividers = [];
    }
    const shown = new Set();
    for (const r of rects) {
      shown.add(r.index);
      setRect(panes[r.index].el, r);
    }
    for (const p of panes) p.el.hidden = !shown.has(p.index);

    while (dividerEls.length > dividers.length) dividerEls.pop().remove();
    while (dividerEls.length < dividers.length) {
      const el = document.createElement('div');
      el.addEventListener('pointerdown', startDrag);
      stage.append(el);
      dividerEls.push(el);
    }
    dividers.forEach((d, i) => {
      const el = dividerEls[i];
      el.className = 'divider ' + d.d + (el.classList.contains('active') ? ' active' : '');
      el.divider = d;
      el.style.left = d.x * 100 + '%';
      el.style.top = d.y * 100 + '%';
      el.style.width = d.d === 'row' ? '' : d.w * 100 + '%';
      el.style.height = d.d === 'col' ? '' : d.h * 100 + '%';
    });

    for (const btn of layoutsEl.querySelectorAll('.layout-btn')) {
      btn.setAttribute('aria-checked', String(btn.dataset.id === layout.id));
    }
  }

  // ---- 境目のドラッグ ---------------------------------------------------

  function startDrag(ev) {
    if (ev.button !== 0) return;
    const el = ev.currentTarget;
    const d = el.divider;
    const layout = NarabeeLayouts.get(state.layout);
    const node = findNode(layout.tree, d.path);
    if (!node) return;
    ev.preventDefault();
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      // 捕捉できなくても、ドラッグ中は iframe がポインタを奪わないので続けられる
    }
    el.classList.add('active');
    document.body.classList.add('dragging', d.d);

    const box = stage.getBoundingClientRect();
    const horizontal = d.d === 'row';
    const total = horizontal ? box.width * d.node.w : box.height * d.node.h;
    const min = Math.min(0.45, MIN_PANE_PX / Math.max(1, total));
    const sizes = (state.sizes[layout.id] = state.sizes[layout.id] || {});
    const fr = NarabeeLayouts.fractions(sizes[d.path], node);
    const before = fr.slice(0, d.k).reduce((a, b) => a + b, 0);
    const pair = fr[d.k] + fr[d.k + 1];

    const move = (e) => {
      const pos = horizontal
        ? ((e.clientX - box.left) / box.width - d.node.x) / d.node.w
        : ((e.clientY - box.top) / box.height - d.node.y) / d.node.h;
      const a = Math.max(min, Math.min(pair - min, pos - before));
      fr[d.k] = a;
      fr[d.k + 1] = pair - a;
      sizes[d.path] = fr.slice();
      place();
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.classList.remove('active');
      document.body.classList.remove('dragging', 'row', 'col');
      saveSoon();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** 'r.1.0' のような経路から節を引く。 */
  function findNode(tree, path) {
    let t = tree;
    for (const k of path.split('.').slice(1)) {
      if (typeof t === 'number') return null;
      t = t.c[Number(k)];
    }
    return typeof t === 'number' ? null : t;
  }

  // ---- 枠の中の移動を追う -----------------------------------------------

  function paneByFrameId(frameId) {
    return panes.find((p) => browser.runtime.getFrameId(p.iframe) === frameId) || null;
  }

  function onNavigated(details) {
    if (details.tabId !== tabId || details.frameId === 0) return;
    if (!/^https?:/.test(details.url)) return;
    const p = paneByFrameId(details.frameId);
    if (!p) return;
    showUrl(p, details.url);
    if (state.panes[p.index].url !== details.url) {
      state.panes[p.index].url = details.url;
      saveSoon();
    }
  }

  browser.webNavigation.onCommitted.addListener(onNavigated);
  browser.webNavigation.onHistoryStateUpdated.addListener(onNavigated);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(onNavigated);

  // ---- 背景からの指示 ---------------------------------------------------

  /** 枠を index 番まで見せられるレイアウトに切り替える (足りないときだけ)。 */
  function ensureVisible(index) {
    if (maxed !== null && maxed !== index) maxed = null;
    const layout = NarabeeLayouts.get(state.layout);
    if (NarabeeLayouts.count(layout.tree) > index) return;
    setLayout(['one', 'h2', 'h3', 'g22'][index] || 'g22');
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return undefined;
    if (msg.type === 'load' && Number.isInteger(msg.index) && panes[msg.index]) {
      ensureVisible(msg.index);
      loadPane(msg.index, msg.url);
      place();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === 'escape' && msg.tabId === tabId) {
      // 枠の中のページがタブごと移ろうとした。始めた枠を探してそこで開く。
      let origin = null;
      try {
        origin = new URL(msg.originUrl).origin;
      } catch {
        origin = null;
      }
      const p = panes.find((x) => !x.el.hidden && x.current && new URL(x.current).origin === origin);
      if (p) loadPane(p.index, msg.url);
      else browser.tabs.create({ url: msg.url });
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  // ---- 起動 -------------------------------------------------------------

  async function init() {
    const hello = await browser.runtime.sendMessage({ type: 'board-hello' });
    tabId = hello && hello.tabId;
    state = await NarabeeState.load();
    buildLayoutButtons();
    for (let i = 0; i < NarabeeState.MAX_PANES; i += 1) panes.push(createPane(i));
    place();
    for (const p of panes) {
      applyZoom(p);
      const url = state.panes[p.index].url;
      showUrl(p, url);
      if (url) p.iframe.src = url;
    }
  }

  init();
})();
