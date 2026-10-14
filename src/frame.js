/**
 * board の枠の中に差し込むスクリプト (background.js が executeScript で入れる)。
 *
 * target="_top" / "_parent" のリンクとフォームは、そのままだと board の
 * タブごと移動してしまう。board の直下の枠でだけ、枠の中で開くように直す。
 * 同じ枠に何度差し込まれても、処理は一度だけ登録する。
 */
(() => {
  if (window.__narabeeFrame) return;
  window.__narabeeFrame = true;
  // board の直下の枠だけ。もっと深い枠の _parent は親の枠を指すので正しい。
  if (window === window.top || window.parent !== window.top) return;

  const ESCAPING = /^_(top|parent)$/i;

  function effectiveTarget(el) {
    if (el.hasAttribute('target')) return el.getAttribute('target');
    const base = document.querySelector('base[target]');
    return base ? base.getAttribute('target') : '';
  }

  document.addEventListener(
    'click',
    (ev) => {
      const a = ev.target instanceof Element ? ev.target.closest('a[href], area[href]') : null;
      if (a && ESCAPING.test(effectiveTarget(a))) a.setAttribute('target', '_self');
    },
    true
  );

  document.addEventListener(
    'submit',
    (ev) => {
      const form = ev.target;
      const submitter = ev.submitter;
      const t = submitter && submitter.hasAttribute('formtarget') ? submitter.getAttribute('formtarget') : effectiveTarget(form);
      if (!ESCAPING.test(t)) return;
      if (submitter && submitter.hasAttribute('formtarget')) submitter.setAttribute('formtarget', '_self');
      else form.setAttribute('target', '_self');
    },
    true
  );
})();
