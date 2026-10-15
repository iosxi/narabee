(() => {
  const stage = document.getElementById('stage');
  const layoutsEl = document.getElementById('layouts');
  const bar = document.getElementById('bar');
  const tpl = document.getElementById('pane-tpl');

  const ZOOM_STEPS = [0.3, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const MIN_PANE_PX = 80;
  /** 見出しのボタンを間引き始める枠の幅 */
  const NARROW_PX = 380;

  /** この board の識別子 (URL の ?b=)。無ければ v8 までの board と同じ保存先を使う */
  const boardId = new URLSearchParams(location.search).get('b') || '';
  let state = NarabeeState.blank();
  let tabId = null;
  /** その枠だけを大きくしているときの置き場所 (state.order の添字)。していなければ null。 */
  let maxed = null;
  const panes = [];
  let dividerEls = [];

  // ---- 保存 -----------------------------------------------------------

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => NarabeeState.save(state, boardId), 300);
  }
  window.addEventListener('pagehide', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      NarabeeState.save(state, boardId);
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
      btn.addEventListener('click', () => {
        setLayout(layout.id);
        hideBar();
      });
      layoutsEl.append(btn);
    }
  }

  function setLayout(id) {
    state.layout = NarabeeLayouts.get(id).id;
    maxed = null;
    place();
    saveSoon();
  }

  // ---- 上の帯の表示 -----------------------------------------------------
  //
  // 帯は普段は隠しておく。開いた直後とタブの右クリック「narabee レイアウトバーを表示」で出し、
  // レイアウトを選んだとき・× を押したとき・BAR_AUTO_HIDE_MS たったときに隠す。
  // 帯の上にマウスがある間は数えない (離れてから数え直す)。

  const BAR_AUTO_HIDE_MS = 15000;
  let barTimer = null;

  function armBarTimer() {
    clearTimeout(barTimer);
    barTimer = setTimeout(hideBar, BAR_AUTO_HIDE_MS);
  }

  function showBar() {
    document.body.classList.remove('bar-hidden');
    if (!bar.matches(':hover')) armBarTimer();
  }

  function hideBar() {
    clearTimeout(barTimer);
    document.body.classList.add('bar-hidden');
  }

  bar.addEventListener('pointerenter', () => clearTimeout(barTimer));
  bar.addEventListener('pointerleave', () => {
    if (!document.body.classList.contains('bar-hidden')) armBarTimer();
  });
  document.getElementById('bar-close').addEventListener('click', hideBar);

  // ---- 枠 ---------------------------------------------------------------
  //
  // panes[i] は iframe を持つ枠そのもの (i は保存の state.panes の添字)。画面のどこに出すかは
  // 置き場所 (slot) で、state.order[slot] = i。番号 (①〜④)・「枠に送る」の枠 N・題名に使う
  // 枠 1・大きくした枠は置き場所で数える。入れ替えは order だけを変える (iframe は動かさない)。

  function slotOf(p) {
    return state.order.indexOf(p.index);
  }

  function paneInSlot(slot) {
    return panes[state.order[slot]];
  }

  function createPane(index) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const p = {
      index,
      el,
      iframe: el.querySelector('iframe'),
      input: el.querySelector('.url'),
      zoomBtn: el.querySelector('.zoom'),
      autoBtn: el.querySelector('.auto'),
      /** 枠の中で今表示している URL (webNavigation で追う) */
      current: '',
    };
    const num = el.querySelector('.num');
    num.addEventListener('pointerdown', (ev) => startUrlDrag(p, ev));

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
      toggleMax(slotOf(p));
    });

    new ResizeObserver(() => {
      el.classList.toggle('narrow', el.clientWidth > 0 && el.clientWidth < NARROW_PX);
    }).observe(el);

    stage.append(el);
    return p;
  }

  function showUrl(p, url) {
    p.current = url;
    // 題名は frame.js が知らせる。新しいページは自分で知らせてくるので、ここで消すのは
    // 枠を空にしたときだけ (# の変化やページ内の切り替えでは知らせが来ないため)
    if (!url) p.title = '';
    if (slotOf(p) === 0) updateDocTitle();
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

  /** 枠を最初の何も無い状態に戻す。自動の再読み込みもやめる (次に入れるサイトに持ち越さない)。 */
  function closePane(p) {
    state.panes[p.index].url = '';
    state.panes[p.index].reload = 0;
    showAutoReload(p);
    armAutoReload(p);
    showUrl(p, '');
    p.iframe.src = 'about:blank';
    if (maxed === slotOf(p)) {
      maxed = null;
      place();
    }
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
    setZoom(p, ZOOM_STEPS[i]);
  }

  function setZoom(p, z) {
    state.panes[p.index].zoom = z;
    applyZoom(p);
    saveSoon();
  }

  // ---- 見出しから開くダイアログ (倍率・自動の再読み込み) -----------------------
  //
  // 入力した値はすぐには反映せず、「セット」(Enter) で反映して閉じる。× ・Esc・
  // ダイアログの外を押す (枠の中のページを押すと board から焦点が外れる) と、
  // 入力を捨てて閉じる。開いたボタンをもう一度押しても閉じる。

  /** 開いているダイアログ { el, p (枠), btn (開いたボタン) }。閉じていれば null */
  let popup = null;

  /** 枠 p のボタン btn の下にダイアログ el を開く。同じボタンで開いていれば閉じて false。 */
  function openPopup(el, p, btn) {
    if (popup && popup.btn === btn) {
      closePopup();
      return false;
    }
    closePopup();
    popup = { el, p, btn };
    el.querySelector('.zd-error').hidden = true;
    el.hidden = false;
    // ボタンの下に出す。画面からはみ出すなら内側に寄せる
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2));
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    return true;
  }

  function closePopup() {
    if (!popup) return;
    const { el } = popup;
    popup = null;
    // 見えなくなった入力欄に焦点を残さない
    if (el.contains(document.activeElement)) document.activeElement.blur();
    el.hidden = true;
    if (el === reloadDialog) resumeAutoReload();
  }

  function focusInput(input) {
    input.focus();
    input.select();
  }

  /** ダイアログ内に誤りを知らせ、開いたままにする。 */
  function popupError(el, text, input) {
    const err = el.querySelector('.zd-error');
    err.textContent = text;
    err.hidden = false;
    focusInput(input);
  }

  // ダイアログの外を押したら閉じる。開いたボタンなら、そのボタンのクリックが閉じる
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (!popup || popup.el.contains(ev.target)) return;
      if (ev.target instanceof Element && ev.target.closest('button') === popup.btn) return;
      closePopup();
    },
    true
  );
  // 枠の中のページを押すと、board から焦点が外れる (board には pointerdown が来ない)
  window.addEventListener('blur', closePopup);

  // ---- 倍率のダイアログ ---------------------------------------------------
  //
  // 見出しの倍率 (「100%」) を押すと開く。「リセット」は 100% にして閉じる。

  const ZOOM_MIN = 10;
  const ZOOM_MAX = 500;
  const zoomDialog = document.getElementById('zoom-dialog');
  const zoomInput = zoomDialog.querySelector('.zd-input');

  function openZoomDialog(p) {
    zoomInput.value = String(Math.round(state.panes[p.index].zoom * 100));
    if (openPopup(zoomDialog, p, p.zoomBtn)) focusInput(zoomInput);
  }

  zoomDialog.querySelector('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!popup) return;
    const v = Number(zoomInput.value.trim());
    if (!Number.isFinite(v) || v < ZOOM_MIN || v > ZOOM_MAX) {
      popupError(zoomDialog, ZOOM_MIN + '〜' + ZOOM_MAX + ' の数で入れてください', zoomInput);
      return;
    }
    setZoom(popup.p, v / 100);
    closePopup();
  });
  zoomDialog.querySelector('.zd-reset').addEventListener('click', () => {
    if (popup) setZoom(popup.p, 1);
    closePopup();
  });

  // ---- 自動の再読み込み ---------------------------------------------------
  //
  // 枠ごとに間隔 (state.panes[i].reload 秒) を覚え、その枠のページを読み直す。
  // 次の読み直しまでの時間は、ページの読み込みが終わったところから数え直す
  // (読み込みに間隔より長くかかるページを、途中で読み直し続けないため。
  // 枠の中でリンクを押して移ったときも、そこから数え直す)。
  // 次のときは読み直さず、次の回に回す:
  // - 枠が空のとき、読み込みの途中のとき
  // - POST で開いたページ (読み直すと Firefox が再送信の確認を出す。送信を繰り返させない)
  // - 枠の中の入力欄に焦点があるとき (打ちかけの文字を消さないため)
  // - 自動の再読み込みのダイアログを開いているとき (どの枠も)。読み込んだページが焦点を
  //   取ると board から焦点が外れ、入力中のダイアログが閉じてしまうため。閉じたら、
  //   その間に時刻が来た枠をすぐ読み直す

  const RELOAD_MAX_MIN = 1440;
  /** 読み込みの途中とみなす長さの上限。これを過ぎたら止まっているとみなして読み直す */
  const LOADING_STALE_MS = 60000;
  const reloadDialog = document.getElementById('reload-dialog');
  const reloadMin = reloadDialog.querySelector('.rd-min');
  const reloadSec = reloadDialog.querySelector('.rd-sec');

  for (const el of [zoomDialog, reloadDialog]) {
    el.querySelector('.zd-close').addEventListener('click', closePopup);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closePopup();
    });
  }

  /** 125 秒 -> 「2分5秒」 */
  function formatInterval(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return (m ? m + '分' : '') + (s ? s + '秒' : '');
  }

  function showAutoReload(p) {
    const sec = state.panes[p.index].reload;
    const btn = p.autoBtn;
    // 狭い枠では間隔の文字を隠す (CSS)。間隔は title で分かる
    btn.querySelector('.auto-text').textContent = sec ? formatInterval(sec) : '';
    btn.classList.toggle('on', sec > 0);
    btn.classList.toggle('paused', sec > 0 && !!p.posted);
    if (!sec) btn.title = '自動で再読み込みする間隔を指定する';
    else if (p.posted) btn.title = formatInterval(sec) + 'ごとに自動で再読み込み (いまは POST で開いたページなので止めている。別のページに移ると再開する)';
    else btn.title = formatInterval(sec) + 'ごとに自動で再読み込み (押すと変更)';
  }

  /** 次の自動の再読み込みを、今から間隔の後に置き直す。 */
  function armAutoReload(p) {
    clearTimeout(p.autoTimer);
    p.autoTimer = null;
    const sec = state.panes[p.index].reload;
    if (sec > 0) p.autoTimer = setTimeout(() => autoReload(p), sec * 1000);
  }

  const AUTO_RELOAD_CODE = `(() => {
    const a = document.activeElement;
    const typing = a && (a.isContentEditable || /^(textarea|select)$/i.test(a.tagName) ||
      (/^input$/i.test(a.tagName) && !/^(button|submit|reset|checkbox|radio|image|range|color|file|hidden)$/i.test(a.type)));
    if (typing && document.hasFocus()) return 'typing';
    location.reload();
    return 'reloaded';
  })()`;

  async function autoReload(p) {
    armAutoReload(p); // 読み込みが終われば、そこから数え直す
    if (!p.current || p.posted) return;
    if (p.loadingSince && Date.now() - p.loadingSince < LOADING_STALE_MS) return;
    if (popup && popup.el === reloadDialog) {
      p.autoDue = true;
      return;
    }
    const frameId = browser.runtime.getFrameId(p.iframe);
    if (tabId === null || frameId < 0) return;
    try {
      await browser.tabs.executeScript(tabId, { frameId, code: AUTO_RELOAD_CODE });
    } catch {
      // エラーページなどで差し込めないときは、覚えている URL を読み直す
      p.iframe.src = p.current;
    }
  }

  /** ダイアログを開いている間に時刻が来た枠を読み直す */
  function resumeAutoReload() {
    for (const p of panes) {
      if (!p.autoDue) continue;
      p.autoDue = false;
      if (state.panes[p.index].reload > 0) autoReload(p);
    }
  }

  function setAutoReload(p, sec) {
    // 間隔を変えた枠は、新しい間隔で数え直す (閉じたときにすぐ読み直さない)
    p.autoDue = false;
    state.panes[p.index].reload = sec;
    showAutoReload(p);
    armAutoReload(p);
    saveSoon();
  }

  function openReloadDialog(p) {
    const sec = state.panes[p.index].reload;
    reloadMin.value = String(Math.floor(sec / 60));
    reloadSec.value = String(sec % 60);
    // 分だけの指定なら分の欄、それ以外は秒の欄に焦点を置く
    if (openPopup(reloadDialog, p, p.autoBtn)) focusInput(sec && !(sec % 60) ? reloadMin : reloadSec);
  }

  /** 空欄は 0。0 以上の整数でなければ NaN */
  function readCount(input) {
    const t = input.value.trim();
    if (!t) return 0;
    return /^\d+$/.test(t) ? Number(t) : NaN;
  }

  reloadDialog.querySelector('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!popup) return;
    const m = readCount(reloadMin);
    const sec = readCount(reloadSec);
    if (!Number.isInteger(m) || m > RELOAD_MAX_MIN) {
      popupError(reloadDialog, '分は 0〜' + RELOAD_MAX_MIN + ' の整数で入れてください', reloadMin);
      return;
    }
    if (!Number.isInteger(sec) || sec > 59) {
      popupError(reloadDialog, '秒は 0〜59 の整数で入れてください', reloadSec);
      return;
    }
    // 0 分 0 秒は「更新なし」
    setAutoReload(popup.p, m * 60 + sec);
    closePopup();
  });
  reloadDialog.querySelector('.rd-off').addEventListener('click', () => {
    if (popup) setAutoReload(popup.p, 0);
    closePopup();
  });

  // 枠のページの読み込みの始まりと終わり、POST で開いたかを追う

  function paneOfFrame(details) {
    if (details.tabId !== tabId || details.frameId === 0) return null;
    return paneByFrameId(details.frameId);
  }

  browser.webNavigation.onBeforeNavigate.addListener((d) => {
    const p = paneOfFrame(d);
    if (p) p.loadingSince = Date.now();
  });
  for (const ev of [browser.webNavigation.onCompleted, browser.webNavigation.onErrorOccurred]) {
    ev.addListener((d) => {
      const p = paneOfFrame(d);
      if (!p) return;
      p.loadingSince = 0;
      armAutoReload(p);
    });
  }
  // 枠の文書の要求 (転送されたら転送先の要求) の method を覚え、読み込みが確定したときに見る。
  // 戻る・進むでキャッシュから出たページは要求が無いので、POST ではないとみなす。
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      const p = paneOfFrame(d);
      if (p) p.lastRequest = { url: d.url, method: d.method };
    },
    { urls: ['<all_urls>'], types: ['sub_frame'] }
  );
  browser.webNavigation.onCommitted.addListener((d) => {
    const p = paneOfFrame(d);
    if (!p) return;
    const req = p.lastRequest;
    p.lastRequest = null;
    const noHash = (u) => u.split('#')[0];
    p.posted = !!req && req.method === 'POST' && noHash(req.url) === noHash(d.url);
    showAutoReload(p);
  });

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
      case 'zoomdialog':
        openZoomDialog(p);
        break;
      case 'autoreload':
        openReloadDialog(p);
        break;
      case 'max':
        toggleMax(slotOf(p));
        break;
      case 'close':
        closePane(p);
        break;
      case 'popout':
        if (p.current) browser.tabs.create({ url: p.current });
        break;
      default:
        break;
    }
  }

  function toggleMax(slot) {
    maxed = maxed === slot ? null : slot;
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
    // r.index は置き場所
    const shown = new Set();
    for (const r of rects) {
      const p = paneInSlot(r.index);
      shown.add(p);
      setRect(p.el, r);
    }
    for (const p of panes) {
      p.el.hidden = !shown.has(p);
      p.el.querySelector('.num').textContent = String(slotOf(p) + 1);
    }

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

  // ---- 枠の番号のドラッグで入れ替え・コピー ----------------------------------------
  //
  // 見出しの丸付き数字を別の枠に落とす。落とした先の枠の左半分なら入れ替え、右半分ならコピー。
  // - 入れ替え: 2 つの枠の置き場所 (state.order) を交換する。iframe は読み込み直さないので、
  //   中のページ (ログイン後の画面・入力中の内容・動画) も倍率・自動の再読み込みもそのまま移る。
  // - コピー: 落とした先の枠に同じ URL を読み込む (倍率や自動の再読み込みは先の枠のまま)。
  // HTML のドラッグ & ドロップは使わない。iframe の上ではドラッグのイベントが board に届かない
  // ため。境目のドラッグと同じく、押している間は body.dragging で iframe がポインタを奪わない
  // ようにし、落とした位置の枠を探す。少し動かすまではドラッグとみなさない (クリックや見出しの
  // ダブルクリックを妨げない)。空の枠からはドラッグしない。

  const URL_DRAG_PX = 4;
  const CIRCLED = ['①', '②', '③', '④'];

  /** 置き場所を入れ替える。 */
  function swapPanes(a, b) {
    const sa = slotOf(a);
    const sb = slotOf(b);
    state.order[sa] = b.index;
    state.order[sb] = a.index;
    place();
    updateDocTitle();
    saveSoon();
  }

  function startUrlDrag(src, ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const num = ev.currentTarget;
    try {
      num.setPointerCapture(ev.pointerId);
    } catch {
      // 捕捉できなくても、押している間は iframe がポインタを奪わないので続けられる
    }
    document.body.classList.add('dragging');
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let ghost = null;
    /** { p, mode: 'swap' | 'copy' } か null */
    let drop = null;

    const dropAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      const el = hit && hit.closest('.pane');
      const p = el && panes.find((q) => q.el === el);
      if (!p || p === src) return null;
      const r = el.getBoundingClientRect();
      return { p, mode: x < r.left + r.width / 2 ? 'swap' : 'copy' };
    };
    const showDrop = (d) => {
      if (drop && (!d || d.p !== drop.p)) drop.p.el.classList.remove('drop-target', 'drop-swap', 'drop-copy');
      drop = d;
      if (!d) return;
      const from = CIRCLED[slotOf(src)];
      const to = CIRCLED[slotOf(d.p)];
      d.p.el.querySelector('.dz-swap small').textContent = from + ' と ' + to + ' の場所を入れ替える';
      d.p.el.querySelector('.dz-copy small').textContent = from + ' の URL を ' + to + ' で開く';
      d.p.el.classList.add('drop-target');
      d.p.el.classList.toggle('drop-swap', d.mode === 'swap');
      d.p.el.classList.toggle('drop-copy', d.mode === 'copy');
    };
    const move = (e) => {
      if (!ghost) {
        if (!src.current || Math.hypot(e.clientX - x0, e.clientY - y0) < URL_DRAG_PX) return;
        ghost = document.createElement('div');
        ghost.className = 'url-ghost';
        ghost.textContent = String(slotOf(src) + 1);
        document.body.append(ghost);
        document.body.classList.add('moving-url');
      }
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
      showDrop(dropAt(e.clientX, e.clientY));
    };
    const end = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('dragging', 'moving-url');
      const d = ghost && e.type === 'pointerup' ? dropAt(e.clientX, e.clientY) : null;
      if (ghost) ghost.remove();
      showDrop(null);
      if (!d || !src.current) return;
      if (d.mode === 'swap') swapPanes(src, d.p);
      else loadPane(d.p.index, src.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
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
  browser.webNavigation.onCommitted.addListener(restoreScrollOnCommit);
  browser.webNavigation.onHistoryStateUpdated.addListener(onNavigated);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(onNavigated);

  // ---- スクロール位置の記録と復元 -----------------------------------------
  //
  // board を開くと、枠には保存した URL を読み込み直す。普通のタブを読み直した
  // ときのような位置の復元は効かないので、frame.js が知らせる位置を覚えておき、
  // 同じ URL が読み込まれたら戻す。後から中身が伸びるページもあるので、届くまで
  // しばらくやり直す。途中で利用者が動かしたら、そこでやめる。

  const RESTORE_TRIES = 40;
  const RESTORE_INTERVAL_MS = 150;

  function restoreCode(x, y) {
    return `new Promise((done) => {
      let stop = false;
      const quit = () => { stop = true; };
      for (const ev of ['wheel', 'keydown', 'touchstart', 'mousedown']) {
        window.addEventListener(ev, quit, { once: true, capture: true });
      }
      let n = 0;
      const tick = () => {
        if (stop) return done(false);
        window.scrollTo(${x}, ${y});
        n += 1;
        const reached = Math.abs(window.scrollY - ${y}) < 2 && Math.abs(window.scrollX - ${x}) < 2;
        if (reached || n >= ${RESTORE_TRIES}) return done(reached);
        setTimeout(tick, ${RESTORE_INTERVAL_MS});
      };
      tick();
    })`;
  }

  function restoreScrollOnCommit(details) {
    if (details.tabId !== tabId || details.frameId === 0) return;
    // 枠を作った直後の about:blank の読み込みも届くので、Web のページだけを見る
    if (!/^https?:/.test(details.url)) return;
    const p = paneByFrameId(details.frameId);
    if (!p || !p.pendingScroll) return;
    const sc = p.pendingScroll;
    p.pendingScroll = null;
    if (details.url !== sc.url) {
      p.restoring = false;
      return;
    }
    browser.tabs
      .executeScript(tabId, { frameId: details.frameId, code: restoreCode(sc.x, sc.y), runAt: 'document_idle' })
      .catch(() => {})
      .finally(() => {
        p.restoring = false;
      });
  }

  function recordScroll(msg, sender) {
    if (!sender.tab || sender.tab.id !== tabId) return;
    const p = paneByFrameId(sender.frameId);
    // 戻している途中の位置は、戻し終わるまで記録しない (0 で上書きしないため)
    if (!p || p.restoring) return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || typeof msg.url !== 'string') return;
    state.panes[p.index].scroll = { url: msg.url, x: msg.x, y: msg.y };
    saveSoon();
  }

  // ---- タブ (ウィンドウ) の題名 ---------------------------------------------
  //
  // 「narabee」だけではウィンドウを見分けられないので、枠 1 のページの題名を付けて
  // 「narabee(題名)」にする。枠の中は別のサイトなので題名は frame.js が知らせる。

  function updateDocTitle() {
    const p = paneInSlot(0);
    const title = p && p.current && p.title ? p.title.trim() : '';
    document.title = title ? 'narabee(' + title + ')' : 'narabee';
  }

  function recordTitle(msg, sender) {
    if (!sender.tab || sender.tab.id !== tabId || typeof msg.title !== 'string') return;
    const p = paneByFrameId(sender.frameId);
    if (!p) return;
    p.title = msg.title;
    if (slotOf(p) === 0) updateDocTitle();
  }

  // ---- 枠の中の子の iframe から top への合図 ------------------------------------
  //
  // YouTube のチャット欄は × などの合図を window.top に送る。普通のタブなら top は watch
  // ページだが、枠の中では board になる。frame.js が宛先を board の origin に変えさせて
  // いるので、ここに届いたものを、送り主の親 (枠のページ) に渡し直す。送り主が枠の
  // ページそのもの・枠の外の場合や、枠のページと origin が違う場合は渡さない。

  window.addEventListener('message', (ev) => {
    const src = ev.source;
    if (!src || tabId === null || ev.origin !== 'https://www.youtube.com') return;
    let parentWin;
    try {
      parentWin = src.parent;
    } catch {
      return;
    }
    const p = panes.find((q) => q.iframe.contentWindow === parentWin && q.iframe.contentWindow !== src);
    if (!p || !p.current) return;
    try {
      if (new URL(p.current).origin !== ev.origin) return;
    } catch {
      return;
    }
    let index = -1;
    for (let i = 0; i < parentWin.length; i += 1) {
      if (parentWin[i] === src) {
        index = i;
        break;
      }
    }
    const frameId = browser.runtime.getFrameId(p.iframe);
    if (index < 0 || frameId < 0) return;
    let data;
    try {
      data = JSON.parse(JSON.stringify(ev.data));
    } catch {
      return;
    }
    browser.tabs.sendMessage(tabId, { type: 'relay-message', index, data, origin: ev.origin }, { frameId }).catch(() => {});
  });

  // ---- 背景からの指示 ---------------------------------------------------

  /** 置き場所 slot まで見せられるレイアウトに切り替える (足りないときだけ)。 */
  function ensureVisible(slot) {
    if (maxed !== null && maxed !== slot) maxed = null;
    const layout = NarabeeLayouts.get(state.layout);
    if (NarabeeLayouts.count(layout.tree) > slot) return;
    setLayout(['one', 'h2', 'h3', 'g22'][slot] || 'g22');
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg) return undefined;
    if (msg.type === 'show-bar' && msg.tabId === tabId) {
      showBar();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === 'frame-title') {
      recordTitle(msg, sender);
      return undefined;
    }
    if (msg.type === 'frame-scroll') {
      recordScroll(msg, sender);
      return undefined;
    }
    // tabId が付いていれば、その board 宛て (ウィンドウごとに board があるため)。index は置き場所 (枠 N)
    if (msg.type === 'load' && Number.isInteger(msg.index) && paneInSlot(msg.index) && (msg.tabId === undefined || msg.tabId === tabId)) {
      ensureVisible(msg.index);
      loadPane(paneInSlot(msg.index).index, msg.url);
      place();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === 'load-frame' && msg.tabId === tabId) {
      // 普通のタブで済ませたログインから戻ってきた
      const p = paneByFrameId(msg.frameId);
      if (p) loadPane(p.index, msg.url);
      return Promise.resolve({ ok: !!p });
    }
    if (msg.type === 'escape' && msg.tabId === tabId) {
      // 枠の中のページがタブごと移ろうとした (楽天証券の会員ページは画面の
      // 切り替えに window.top.location.replace を使う)。始めた枠を探してそこで開く。
      // URL が一致する枠を優先し、無ければ同じ origin の枠。
      let origin = null;
      try {
        origin = new URL(msg.originUrl).origin;
      } catch {
        origin = null;
      }
      const shown = panes.filter((x) => !x.el.hidden && x.current);
      const p =
        shown.find((x) => x.current === msg.originUrl) ||
        shown.find((x) => {
          try {
            return new URL(x.current).origin === origin;
          } catch {
            return false;
          }
        });
      // 「枠から抜け出す」処理 (top.location = 自分の URL) は、枠で読み直すと
      // 同じ処理がまた走って止まらない。今と同じ URL なら何もしない。
      if (p && p.current !== msg.url) loadPane(p.index, msg.url);
      else if (!p) browser.tabs.create({ url: msg.url });
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  // ---- 起動 -------------------------------------------------------------

  async function init() {
    const hello = await browser.runtime.sendMessage({ type: 'board-hello' });
    tabId = hello && hello.tabId;
    state = await NarabeeState.load(boardId);
    buildLayoutButtons();
    // 帯は board のタブを足したときだけ出す (読み直したときは出さない。背景が決める)
    if (hello && hello.showBar) showBar();
    for (let i = 0; i < NarabeeState.MAX_PANES; i += 1) panes.push(createPane(i));
    place();
    for (const p of panes) {
      applyZoom(p);
      showAutoReload(p);
      armAutoReload(p);
      const url = state.panes[p.index].url;
      showUrl(p, url);
      const sc = state.panes[p.index].scroll;
      if (url && sc && sc.url === url && (sc.x || sc.y)) {
        p.pendingScroll = sc;
        p.restoring = true;
      }
      if (url) p.iframe.src = url;
    }
  }

  init();
})();
