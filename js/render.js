/* render.js — Canvas 棋盘渲染与视口（缩放/平移/高DPI） */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  const COLOR = {
    get bg() { return NG.theme.color('--surface'); },
    get board() { return NG.theme.color('--board-bg'); },
    get grid() { return NG.theme.color('--grid-line'); },
    get gridBold() { return NG.theme.color('--grid-bold'); },
    get fill() { return NG.theme.color('--brand'); },
    get mark() { return NG.theme.color('--text-muted'); },
    get clue() { return NG.theme.color('--text'); },
    get clueDim() { return NG.theme.color('--text-faint'); },
    get highlight() { return NG.theme.color('--hl-fill'); },
    get debugFill() { return NG.theme.color('--debug-fill'); },
    get locked() { return NG.theme.color('--locked-bg'); },
    get autoX() { return NG.theme.color('--auto-x'); },
    get alertBg() { return NG.theme.color('--alert-bg'); },
  };

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    let size = 0;
    let data = null;          // {cells, clues, locks, grayRows, grayCols, hover, solved, solution}
    let scale = 32;           // 每格像素（CSS 像素）
    let ox = 0, oy = 0;       // 内容区平移偏移
    let cssW = 0, cssH = 0;
    let dpr = 1;
    let rafId = 0;
    let clueScale = 1;        // 提示数字缩放（1 / 1.3 / 1.6）

    function metrics() {
      if (!data) return { clueW: 0, clueH: 0 };
      const maxRow = Math.max(1, ...data.clues.rows.map((c) => c.filter((n) => n > 0).length || 1));
      const maxCol = Math.max(1, ...data.clues.cols.map((c) => c.filter((n) => n > 0).length || 1));
      const base = Math.max(10, Math.min(15, scale * 0.42));
      // 字号随 clueScale 放大，但不超过格子的 85%，避免挤爆格子
      const ch = Math.min(base * clueScale, scale * 0.85);
      return {
        clueW: Math.round(maxRow * ch + 10),
        clueH: Math.round(maxCol * ch + 10),
        lh: ch, cw: ch, maxRow, maxCol,
      };
    }

    function contentSize() {
      const m = metrics();
      return { w: m.clueW + size * scale, h: m.clueH + size * scale, m };
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      clampOffset();
      requestDraw();
    }

    function clampOffset() {
      const { w, h } = contentSize();
      ox = w <= cssW ? Math.round((cssW - w) / 2) : Math.min(0, Math.max(cssW - w, ox));
      oy = h <= cssH ? Math.round((cssH - h) / 2) : Math.min(0, Math.max(cssH - h, oy));
    }

    function fitToScreen() {
      const m0 = metrics();
      const availW = cssW - m0.clueW - 8, availH = cssH - m0.clueH - 8;
      const s = Math.floor(Math.min(availW / size, availH / size));
      scale = Math.max(14, Math.min(44, s || 14));
      clampOffset();
      requestDraw();
    }

    function zoomAt(px, py, factor) {
      const { m } = contentSize();
      const old = scale;
      scale = Math.max(12, Math.min(64, Math.round(scale * factor)));
      if (scale === old) return;
      // 保持 (px,py) 指向的内容点不动（棋盘区内）
      const boardX = px - ox - m.clueW, boardY = py - oy - m.clueH;
      const ratio = scale / old;
      ox = Math.round(px - (boardX * ratio) - m.clueW);
      oy = Math.round(py - (boardY * ratio) - m.clueH);
      clampOffset();
      requestDraw();
    }

    function panBy(dx, dy) {
      ox += dx; oy += dy;
      clampOffset();
      requestDraw();
    }

    /** 屏幕坐标 → 格子 index；不在棋盘区返回 -1 */
    function cellAt(px, py) {
      const { m } = contentSize();
      const bx = Math.floor((px - ox - m.clueW) / scale);
      const by = Math.floor((py - oy - m.clueH) / scale);
      if (bx < 0 || by < 0 || bx >= size || by >= size) return -1;
      return by * size + bx;
    }

    function clueAt(px, py) {
      // 命中提示区：返回 {row, col}（用于点击提示高亮，暂未用）
      const { m } = contentSize();
      const col = Math.floor((px - ox - m.clueW) / scale);
      const row = Math.floor((py - oy - m.clueH) / scale);
      return {
        row: py - oy >= m.clueH && row >= 0 && row < size ? row : -1,
        col: px - ox >= m.clueW && col >= 0 && col < size ? col : -1,
      };
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = COLOR.bg;
      ctx.fillRect(0, 0, cssW, cssH);
      if (!data || !size) return;

      const { m } = contentSize();
      const cells = data.cells, locks = data.locks;
      const bOx = ox + m.clueW, bOy = oy + m.clueH;
      const boldEvery = size >= 15 ? 5 : 5;

      // 棋盘底
      ctx.fillStyle = COLOR.board;
      ctx.fillRect(bOx, bOy, size * scale, size * scale);

      // 悬停十字：行列提示区高亮
      if (data.hover >= 0) {
        const hr = Math.floor(data.hover / size), hc = data.hover % size;
        ctx.fillStyle = COLOR.highlight;
        ctx.fillRect(ox + 2, bOy + hr * scale, m.clueW - 4, scale);          // 行提示
        ctx.fillRect(bOx + hc * scale, oy + 2, scale, m.clueH - 4);          // 列提示
      }

      // 格子内容
      const xw = Math.max(1, scale * 0.09);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const i = r * size + c;
          const x = bOx + c * scale, y = bOy + r * scale;
          const v = cells[i];
          const locked = locks && locks[i];
          if (locked) {
            ctx.fillStyle = COLOR.locked;
            ctx.fillRect(x, y, scale, scale);
          }
          if (v === 1) {
            ctx.fillStyle = COLOR.fill;
            ctx.fillRect(x + 0.5, y + 0.5, scale - 1, scale - 1);
          } else if (v === 2 || (locked && data.solution && !data.solution[i])) {
            // 用户 ×（实）或锁定行自动补 ×（淡）
            ctx.strokeStyle = v === 2 ? COLOR.mark : COLOR.autoX;
            ctx.lineWidth = xw;
            ctx.lineCap = 'round';
            const pad = scale * 0.26;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + scale - pad, y + scale - pad);
            ctx.moveTo(x + scale - pad, y + pad); ctx.lineTo(x + pad, y + scale - pad);
            ctx.stroke();
          }
        }
      }

      // debug 显影（L 键）：淡绿标出应填色格，覆盖在玩家填色之上
      if (data.debugSolution && data.solution) {
        ctx.fillStyle = COLOR.debugFill;
        for (let i = 0; i < size * size; i++) {
          if (data.solution[i]) {
            ctx.fillRect(bOx + (i % size) * scale, bOy + Math.floor(i / size) * scale, scale, scale);
          }
        }
      }

      // 网格线
      ctx.strokeStyle = COLOR.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k <= size; k++) {
        if (k % boldEvery === 0) continue;
        const gx = Math.round(bOx + k * scale) + 0.5;
        const gy = Math.round(bOy + k * scale) + 0.5;
        ctx.moveTo(gx, bOy); ctx.lineTo(gx, bOy + size * scale);
        ctx.moveTo(bOx, gy); ctx.lineTo(bOx + size * scale, gy);
      }
      ctx.stroke();
      ctx.strokeStyle = COLOR.gridBold;
      ctx.beginPath();
      for (let k = 0; k <= size; k += boldEvery) {
        const gx = Math.round(bOx + k * scale) + 0.5;
        const gy = Math.round(bOy + k * scale) + 0.5;
        ctx.moveTo(gx, bOy); ctx.lineTo(gx, bOy + size * scale);
        ctx.moveTo(bOx, gy); ctx.lineTo(bOx + size * scale, gy);
      }
      // 棋盘外框
      ctx.strokeRect(bOx + 0.5, bOy + 0.5, size * scale - 1, size * scale - 1);
      ctx.stroke();

      // 提示文字
      const fs = Math.round(Math.max(9, Math.min(22, m.cw * 0.95)));
      ctx.font = `500 ${fs}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
      // 行提示：右对齐固定步进（数字宽 + 恒定间隔），警示行淡红底
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < size; r++) {
        const clue = data.clues.rows[r].length ? data.clues.rows[r] : [0];
        const grayArr = data.grayRows ? data.grayRows[r] : null;   // boolean[]
        const y = bOy + r * scale + scale / 2;
        if (data.alertRows && data.alertRows[r]) {
          ctx.fillStyle = COLOR.alertBg;
          ctx.fillRect(ox + 2, bOy + r * scale + 1, m.clueW - 4, scale - 2);
        }
        let x = bOx - 8;
        for (let k = clue.length - 1; k >= 0; k--) {
          const s = String(clue[k]);
          ctx.fillStyle = grayArr && grayArr[k] ? COLOR.clueDim : COLOR.clue;
          ctx.fillText(s, x, y);
          x -= s.length * m.cw + m.cw * 0.45;
        }
      }
      // 列提示：纵向堆叠，警示列淡红底
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let c = 0; c < size; c++) {
        const clue = data.clues.cols[c].length ? data.clues.cols[c] : [0];
        const grayArr = data.grayCols ? data.grayCols[c] : null;
        const x = bOx + c * scale + scale / 2;
        if (data.alertCols && data.alertCols[c]) {
          ctx.fillStyle = COLOR.alertBg;
          ctx.fillRect(bOx + c * scale + 1, oy + 2, scale - 2, m.clueH - 4);
        }
        let y = bOy - 6;
        for (let k = clue.length - 1; k >= 0; k--) {
          ctx.fillStyle = grayArr && grayArr[k] ? COLOR.clueDim : COLOR.clue;
          ctx.fillText(String(clue[k]), x, y);
          y -= m.lh;
        }
      }
    }

    function requestDraw() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
    }

    function setData(d) { data = d; requestDraw(); }
    function setLevel(sz) { size = sz; fitToScreen(); }
    function setClueScale(v) {
      clueScale = v || 1;
      clampOffset();
      requestDraw();
    }

    window.addEventListener('resize', () => { resize(); });

    return {
      resize, draw, requestDraw, setData, setLevel, setClueScale,
      cellAt, clueAt, fitToScreen, zoomAt, panBy, clampOffset,
      get scale() { return scale; },
      get metrics() { return metrics(); },
    };
  }

  NG.createRenderer = createRenderer;
})();
