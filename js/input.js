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
   *   cluePin(key)                                   // 点击提示条带钉选 'r3' / 'c7'（再次点击取消）
   *   axisLock() → boolean                           // 轴向锁定开关（防手抖误涂，默认开）
   */
  function attachInput(canvas, renderer, h) {
    const pointers = new Map();   // pointerId → {x, y}
    let mode = 'none';
    let paintTarget = -1;
    let lastCell = -1;
    let panPrev = null;
    let pinchPrev = null;
    // 轴向锁定（防手抖误涂）：起点格锚定，首次明显位移锁定横/竖轴，
    // 本笔内填色强制落在锚点行（或列）上，指针偏离时投影回轴线
    let anchor = null;      // {col, row} 起点格坐标
    let anchorPx = null;    // {x, y} 起点像素
    let axis = 'none';      // none | h | v

    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    /** 画布像素 → 格坐标（可为负/超界，调用方自行 clamp） */
    function boardCoord(p) {
      const m = renderer.metrics, off = renderer.offset, sc = renderer.scale;
      return {
        col: Math.floor((p.x - off.ox - m.clueW) / sc),
        row: Math.floor((p.y - off.oy - m.clueH) / sc),
      };
    }
    const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function startPinch() {
      const [a, b] = [...pointers.values()];
      if (mode === 'paint') {
        mode = 'none';
        lastCell = -1;
        anchor = null; anchorPx = null; axis = 'none';
        h.paintEnd();
      }
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
        anchor = boardCoord(p);
        anchorPx = p;
        axis = 'none';
        h.paintBegin();
        h.paint(idx, target);
        h.hover(idx);
      } else {
        // 提示条带点击：钉选行/列高亮（左键）
        const cl = renderer.clueAt && e.button === 0 ? renderer.clueAt(p.x, p.y) : null;
        if (cl && (cl.row >= 0 || cl.col >= 0) && h.cluePin) {
          mode = 'clue';
          h.cluePin(cl.row >= 0 ? 'r' + cl.row : 'c' + cl.col);
        } else {
          mode = 'pan';
          panPrev = p;
        }
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
        const size = renderer.size;
        const lock = h.axisLock ? h.axisLock() : true;
        if (lock && anchor) {
          // —— 轴向锁定路径：投影回锚点行/列，沿轴插值补格 ——
          const dx = p.x - anchorPx.x, dy = p.y - anchorPx.y;
          if (axis === 'none') {
            // 首次位移超过 0.6 格即锁定主方向
            const th = renderer.scale * 0.6;
            if (Math.abs(dx) >= th && Math.abs(dx) >= Math.abs(dy)) axis = 'h';
            else if (Math.abs(dy) >= th && Math.abs(dy) > Math.abs(dx)) axis = 'v';
          }
          if (axis !== 'none') {
            const c = clampI(boardCoord(p).col, 0, size - 1);
            const r = clampI(boardCoord(p).row, 0, size - 1);
            const from = { col: lastCell % size, row: Math.floor(lastCell / size) };
            if (axis === 'h') {
              if (c !== from.col) {
                const step = c > from.col ? 1 : -1;
                for (let cc = from.col + step; ; cc += step) {
                  h.paint(from.row * size + cc, paintTarget);
                  if (cc === c) break;
                }
                lastCell = from.row * size + c;
              }
              h.hover(from.row * size + c);
            } else {
              if (r !== from.row) {
                const step = r > from.row ? 1 : -1;
                for (let rr = from.row + step; ; rr += step) {
                  h.paint(rr * size + from.col, paintTarget);
                  if (rr === r) break;
                }
                lastCell = r * size + from.col;
              }
              h.hover(r * size + from.col);
            }
          }
        } else {
          // —— 自由跟随路径（防误触关闭时）：同行/列跨格插值防丢格 ——
          if (idx >= 0 && idx !== lastCell) {
            const size2 = size || 1;
            const fr = Math.floor(lastCell / size2), fc = lastCell % size2;
            const tr = Math.floor(idx / size2), tc = idx % size2;
            if (fr === tr) {
              const step = tc > fc ? 1 : -1;
              for (let c = fc + step; ; c += step) {
                h.paint(fr * size2 + c, paintTarget);
                if (c === tc) break;
              }
            } else if (fc === tc) {
              const step = tr > fr ? 1 : -1;
              for (let r = fr + step; ; r += step) {
                h.paint(r * size2 + fc, paintTarget);
                if (r === tr) break;
              }
            } else {
              h.paint(idx, paintTarget);   // 斜向跳格：保持旧行为只涂终点
            }
            lastCell = idx;
          }
          h.hover(idx);
        }
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
        anchor = null;
        anchorPx = null;
        axis = 'none';
        h.paintEnd();
      } else if (mode === 'pan' || mode === 'clue') {
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
