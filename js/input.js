/* input.js — 统一输入处理：鼠标/触摸绘制、拖动连画、双指缩放平移、滚轮缩放
   状态机：none → paint（按在棋盘格）/ pan（按在棋盘外）→ pinch（双指） */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} renderer render.js 实例
   * @param {object} h 回调：
   *   decide(index, button) → 目标值(0/1/2) | null   // 决定本笔目标
   *   paintBegin()                                   // 一笔开始（开启撤销事务）
   *   paint(index, value)                            // 应用到格子
   *   paintEnd()                                     // 一笔结束
   *   hover(index)                                   // 十字准星变化
   */
  function attachInput(canvas, renderer, h) {
    const pointers = new Map();   // pointerId → {x, y}
    let mode = 'none';
    let paintTarget = -1;
    let lastCell = -1;
    let panPrev = null;
    let pinchPrev = null;

    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    function startPinch() {
      const [a, b] = [...pointers.values()];
      if (mode === 'paint') { mode = 'none'; h.paintEnd(); }
      mode = 'pinch';
      panPrev = null;
      pinchPrev = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    }

    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获，忽略 */ }
      const p = pos(e);
      pointers.set(e.pointerId, p);

      if (pointers.size === 2) { startPinch(); return; }
      if (pointers.size > 2) return;

      const idx = renderer.cellAt(p.x, p.y);
      if (idx >= 0 && (e.button === 0 || e.button === 2)) {
        const target = h.decide(idx, e.button);
        if (target === null || target === undefined) {
          mode = 'pan';                 // 锁定格 / 已完成：转平移，避免误触
          panPrev = p;
          return;
        }
        mode = 'paint';
        paintTarget = target;
        lastCell = idx;
        h.paintBegin();
        h.paint(idx, target);
        h.hover(idx);
      } else {
        mode = 'pan';
        panPrev = p;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

      if (mode === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (pinchPrev) {
          renderer.panBy(mx - pinchPrev.mx, my - pinchPrev.my);
          if (pinchPrev.d > 0 && d > 0) renderer.zoomAt(mx, my, d / pinchPrev.d);
        }
        pinchPrev = { d, mx, my };
        return;
      }

      const idx = renderer.cellAt(p.x, p.y);

      if (mode === 'paint') {
        if (idx >= 0 && idx !== lastCell) {
          h.paint(idx, paintTarget);
          lastCell = idx;
        }
        h.hover(idx);
      } else if (mode === 'pan') {
        if (panPrev) renderer.panBy(p.x - panPrev.x, p.y - panPrev.y);
        panPrev = p;
      } else if (e.pointerType === 'mouse' && e.buttons === 0) {
        h.hover(idx);
      }
    });

    function endPointer(e) {
      const wasPinch = mode === 'pinch';
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchPrev = null;

      if (mode === 'paint') {
        mode = 'none';
        lastCell = -1;
        h.paintEnd();
      } else if (mode === 'pan') {
        mode = 'none';
        panPrev = null;
      } else if (wasPinch && pointers.size === 0) {
        mode = 'none';
      }
      // pinch → 剩一指：降级为 pan，避免误画
      if (pointers.size === 1) {
        const [only] = [...pointers.values()];
        mode = 'pan';
        panPrev = { x: only.x, y: only.y };
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) h.hover(-1);
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 滚轮缩放（以光标为中心）
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      renderer.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
  }

  NG.attachInput = attachInput;
})();
