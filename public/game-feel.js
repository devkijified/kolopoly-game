'use strict';
// KOLOPOLY premium game feel (2D and 3D alike). Every chunky control gets a
// press-down state that holds for at least one frame (so a fast tap still
// shows the press), a ripple, a weighty click and a light haptic; money
// readouts count up to their new value instead of snapping. Pure DOM, no
// dependencies, about 3 KB. The final text of every number is exact.
(function () {
  const PRESSABLE = '.btn, .iconbtn, .ubtn, .t-btn, .token-pick, .mode-pick, .deed-check, .contract-row, .rush-grab, .pchip, .settings-toggle';
  function onDown(e) {
    const el = e.target && e.target.closest && e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    el.classList.add('kp-press');
    const big = el.matches('.btn.green, .btn:not(.ghost):not(.dark):not(.small), .rush-grab');
    if (typeof window.__kpUiTap === 'function') window.__kpUiTap(big ? 'big' : 'small');
    if (el.matches('.btn, .t-btn, .rush-grab') && getComputedStyle(el).overflow !== 'visible') {
      const r = el.getBoundingClientRect();
      const d = Math.max(r.width, r.height);
      const rip = document.createElement('span');
      rip.className = 'kp-ripple';
      rip.style.width = rip.style.height = d + 'px';
      rip.style.left = ((e.clientX || r.left + r.width / 2) - r.left - d / 2) + 'px';
      rip.style.top = ((e.clientY || r.top + r.height / 2) - r.top - d / 2) + 'px';
      el.appendChild(rip);
      setTimeout(() => rip.remove(), 500);
    }
    const up = () => { setTimeout(() => el.classList.remove('kp-press'), 90); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  // Buttons get overflow hidden only so the ripple stays inside them.
  const st = document.createElement('style');
  st.textContent = '.btn, .t-btn { overflow: hidden; }';
  document.head.appendChild(st);

  // Count-up: watch money readouts; when the number changes, roll it from
  // the old value to the new one over ~550ms and pulse. Text ends exact.
  const MONEY = '.walletbar .wallet-cash, .pchip .cash';
  const parse = (t) => { const m = String(t).replace(/[,\s]/g, '').match(/-?\d+/); return m ? Number(m[0]) : null; };
  const busy = new WeakMap();
  function roll(el, from, to, finalText) {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue));
    if (!node || Math.abs(to - from) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fmt = (v) => finalText.replace(/-?[\d,]+/, Math.round(v).toLocaleString('en-US'));
    const t0 = performance.now(), dur = 550;
    busy.set(el, true);
    el.classList.remove('kp-count'); void el.offsetWidth; el.classList.add('kp-count');
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      node.nodeValue = k < 1 ? fmt(from + (to - from) * e) : finalNodeText;
      if (k < 1) requestAnimationFrame(tick); else busy.delete(el);
    };
    const finalNodeText = node.nodeValue;
    requestAnimationFrame(tick);
  }
  const last = new WeakMap();
  const mo = new MutationObserver(() => {
    document.querySelectorAll(MONEY).forEach((el) => {
      if (busy.get(el)) return;
      const txt = el.textContent, v = parse(txt), prev = last.get(el);
      last.set(el, v);
      if (prev != null && v != null && prev !== v) {
        const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue));
        if (node) roll(el, prev, v, node.nodeValue);
      }
    });
  });
  function start() { mo.observe(document.body, { subtree: true, childList: true, characterData: true }); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
