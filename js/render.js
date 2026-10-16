/* render.js — Canvas 棋盘渲染与视口（缩放/平移/高DPI）
   提示数字绘制在两张离屏层（行/列）上，仅在提示状态或度量变化时重绘；
   主画布每帧只做 blit + 格子内容，拖动/悬停高频重绘开销大幅降低 */
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

  const FONT_STACK = '"JetBrains Mono", ui-monospace, Consolas, monospace';

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    const rowCv = document.createElement('canvas');   // 行提示离屏层（左侧条带）
    const rowCtx = rowCv.getContext('2d');
    const colCv = document.createElement('canvas');   // 列提示离屏层（顶部条带）
    const colCtx = colCv.getContext('2d');
    let size = 0;
    let data = null;          // {cells, clues, locks, grayRows, grayCols, hover, solved, solution, pin}
    let scale = 32;           // 每格像素（CSS 像素）
    let ox = 0, oy = 0;       // 内容区平移偏移
    let cssW = 0, cssH = 0;
    let dpr = 1;
    let rafId = 0;
    let clueScale = 1;        // 提示数字缩放（1 / 1.3 / 1.6）
    let metricsCache = null;  // { key, clues, value }
    let clueOK = false;       // 提示离屏层与 data 是否同步

    /** 度量（按 size/scale/clueScale/clues 引用缓存；提示宽度按实际排布计算，
     *  保证 ox=0 时最靠左的提示数字完整可见） */
    function metrics() {
      if (!data) return { clueW: 0, clueH: 0, lh: 0, cw: 0, gap: 0, fs: 10, maxRow: 1, maxCol: 1 };
      const key = size + '|' + scale + '|' + clueScale;
      if (metricsCache && metricsCache.key === key && metricsCache.clues === data.clues) {
        return metricsCache.value;
      }
      const maxRow = Math.max(1, ...data.clues.rows.map((c) => c.length || 1));
      const maxCol = Math.max(1, ...data.clues.cols.map((c) => c.length || 1));
      const availW = Math.max(60, cssW * 0.32);   // 提示条带可用宽度上限
      const availH = Math.max(60, cssH * 0.32);
      let ch = Math.min(Math.max(10, Math.min(15, scale * 0.42)) * clueScale, scale * 0.85);
      let fs = 10, gap = 0, clueW = 0, clueH = 0;
      // 字号自适应：行提示按实测总宽、列提示按高度与两位数格宽三重约束，
      // 放不下时逐级缩字号（行列同字号，避免观感不一）
      for (let i = 0; i < 5; i++) {
        fs = Math.round(Math.max(8, Math.min(22, ch * 0.95)));
        gap = ch * 0.45;
        ctx.font = `500 ${fs}px ${FONT_STACK}`;
        let maxRowW = 0;
        for (const clue of data.clues.rows) {
          if (!clue.length) continue;
          let w = 0;
          for (const n of clue) w += ctx.measureText(String(n)).width;   // 实测（含两位数）
          w += (clue.length - 1) * gap;
          if (w > maxRowW) maxRowW = w;
        }
        clueW = Math.round(12 + maxRowW);
        clueH = Math.round(maxCol * ch + 10);
        const wide10 = ctx.measureText('10').width > scale * 0.92;   // 列两位数防相邻列重叠
        if (clueW <= availW && clueH <= availH && !wide10) break;
        ch *= 0.85;
      }
      const value = { clueW, clueH, lh: ch, cw: ch, gap, fs, maxRow, maxCol };
      metricsCache = { key, clues: data.clues, value };
      return value;
    }

    function contentSize() {
      const m = metrics();
      return { w: m.clueW + size * scale, h: m.clueH + size * scale, m };
    }

    /** 提示离屏层尺寸跟随度量；尺寸变化即置脏 */
    function ensureClueLayers(m) {
      const w = Math.max(1, Math.round(m.clueW * dpr));
      const ch = Math.max(1, Math.round(m.clueH * dpr));
      const bh = Math.max(1, Math.round(size * scale * dpr));
      if (rowCv.width !== w || rowCv.height !== bh) {
        rowCv.width = w; rowCv.height = bh; clueOK = false;
      }
      // 列条带：宽=棋盘宽、高=clueH（此前误用 clueW 导致底部数字被裁+blit 拉伸变形）
      if (colCv.width !== bh || colCv.height !== ch) {
        colCv.width = bh; colCv.height = ch; clueOK = false;
      }
    }

    /** 单行提示重绘（离屏坐标系：x∈[0,clueW)，y=r*scale 起） */
    function paintClueRow(r) {
      const m = metrics();
      const y0 = r * scale;
      rowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rowCtx.clearRect(0, y0, m.clueW, scale);
      if (data.alertRows && data.alertRows[r]) {
        rowCtx.fillStyle = COLOR.alertBg;
        rowCtx.fillRect(0, y0 + 1, m.clueW - 2, scale - 2);
      }
      const clue = data.clues.rows[r].length ? data.clues.rows[r] : [0];
      const grayArr = data.grayRows ? data.grayRows[r] : null;
      rowCtx.font = `500 ${m.fs}px ${FONT_STACK}`;
      rowCtx.textAlign = 'right';
      rowCtx.textBaseline = 'middle';
      let x = m.clueW - 8;
      const y = y0 + scale / 2;
      for (let k = clue.length - 1; k >= 0; k--) {
        const s = String(clue[k]);
        rowCtx.fillStyle = grayArr && grayArr[k] ? COLOR.clueDim : COLOR.clue;
        rowCtx.fillText(s, x, y);
        x -= rowCtx.measureText(s).width + m.gap;
      }
    }

    /** 单列提示重绘（离屏坐标系：x=c*scale 起，y∈[0,clueH)） */
    function paintClueCol(c) {
      const m = metrics();
      const x0 = c * scale;
      colCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      colCtx.clearRect(x0, 0, scale, m.clueH);
      if (data.alertCols && data.alertCols[c]) {
        colCtx.fillStyle = COLOR.alertBg;
        colCtx.fillRect(x0 + 1, 0, scale - 2, m.clueH - 2);
      }
      const clue = data.clues.cols[c].length ? data.clues.cols[c] : [0];
      const grayArr = data.grayCols ? data.grayCols[c] : null;
      colCtx.font = `500 ${m.fs}px ${FONT_STACK}`;
      colCtx.textAlign = 'center';
      colCtx.textBaseline = 'bottom';
      const x = x0 + scale / 2;
      let y = m.clueH - 6;
      for (let k = clue.length - 1; k >= 0; k--) {
        colCtx.fillStyle = grayArr && grayArr[k] ? COLOR.clueDim : COLOR.clue;
        colCtx.fillText(String(clue[k]), x, y);
        y -= m.lh;
      }
    }

    function paintClueAll() {
      const m = metrics();
      ensureClueLayers(m);
      rowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rowCtx.clearRect(0, 0, m.clueW, size * scale);
      colCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      colCtx.clearRect(0, 0, size * scale, m.clueH);
      for (let r = 0; r < size; r++) paintClueRow(r);
      for (let c = 0; c < size; c++) paintClueCol(c);
      clueOK = true;
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      clueOK = false;   // 位图尺寸随 dpr 变化
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
      clueOK = false;   // scale 变化 → 提示离屏层按新度量重画
      clampOffset();
      requestDraw();
    }

    function zoomAt(px, py, factor) {
      const { m } = contentSize();
      const old = scale;
      scale = Math.max(12, Math.min(64, Math.round(scale * factor)));
      if (scale === old) return;
      clueOK = false;   // scale 变化 → 提示离屏层按新度量重画（否则旧位置数字残留、其他行列错位）
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
      // 命中提示条带：返回 {row, col}（点击钉选行/列高亮用）
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
      if (!clueOK) paintClueAll();

      const { m } = contentSize();
      const cells = data.cells, locks = data.locks;
      const bOx = ox + m.clueW, bOy = oy + m.clueH;
      const boldEvery = 5;

      // 提示离屏层 blit（行/列条带）
      ctx.drawImage(rowCv, ox, oy + m.clueH, m.clueW, size * scale);
      ctx.drawImage(colCv, ox + m.clueW, oy, size * scale, m.clueH);

      // 悬停十字：行列提示区高亮
      if (data.hover >= 0) {
        const hr = Math.floor(data.hover / size), hc = data.hover % size;
        ctx.fillStyle = COLOR.highlight;
        ctx.fillRect(ox + 2, bOy + hr * scale, m.clueW - 4, scale);          // 行提示
        ctx.fillRect(bOx + hc * scale, oy + 2, scale, m.clueH - 4);          // 列提示
      }

      // 点击钉选的行/列：提示条带 + 棋盘整条高亮
      if (data.pin) {
        ctx.fillStyle = COLOR.highlight;
        const p = +data.pin.slice(1);
        if (data.pin[0] === 'r') {
          ctx.fillRect(ox, bOy + p * scale, m.clueW, scale);
          ctx.fillRect(bOx, bOy + p * scale, size * scale, scale);
        } else {
          ctx.fillRect(bOx + p * scale, oy, scale, m.clueH);
          ctx.fillRect(bOx + p * scale, bOy, scale, size * scale);
        }
      }

      // 棋盘底
      ctx.fillStyle = COLOR.board;
      ctx.fillRect(bOx, bOy, size * scale, size * scale);

      // 格子内容（× 两类各合并为一条路径，减少 stroke 次数）
      const xw = Math.max(1, scale * 0.09);
      const pad = scale * 0.26;
      ctx.fillStyle = COLOR.locked;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const i = r * size + c;
          if (locks && locks[i]) ctx.fillRect(bOx + c * scale, bOy + r * scale, scale, scale);
        }
      }
      ctx.fillStyle = COLOR.fill;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const i = r * size + c;
          if (cells[i] === 1) ctx.fillRect(bOx + c * scale + 0.5, bOy + r * scale + 0.5, scale - 1, scale - 1);
        }
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = xw;
      ctx.strokeStyle = COLOR.mark;
      ctx.beginPath();
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const i = r * size + c;
          if (cells[i] === 2) {
            const x = bOx + c * scale, y = bOy + r * scale;
            ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + scale - pad, y + scale - pad);
            ctx.moveTo(x + scale - pad, y + pad); ctx.lineTo(x + pad, y + scale - pad);
          }
        }
      }
      ctx.stroke();
      // 锁定行/列自动补 ×（淡）
      if (locks && data.solution) {
        ctx.strokeStyle = COLOR.autoX;
        ctx.beginPath();
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            const i = r * size + c;
            if (cells[i] !== 2 && locks[i] && !data.solution[i]) {
              const x = bOx + c * scale, y = bOy + r * scale;
              ctx.moveTo(x + pad, y + pad); ctx.lineTo(x + scale - pad, y + scale - pad);
              ctx.moveTo(x + scale - pad, y + pad); ctx.lineTo(x + pad, y + scale - pad);
            }
          }
        }
        ctx.stroke();
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
    }

    function requestDraw() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
    }

    /** 更新数据。
     * @param clueUpdate 'all' 全量重绘提示层 | {rows,cols} 局部重绘指定行/列条带 | 省略 = 只重绘棋盘 */
    function setData(d, clueUpdate) {
      data = d;
      if (clueUpdate === 'all') clueOK = false;
      else if (clueUpdate && typeof clueUpdate === 'object' && clueOK) {
        // 防御：局部重绘前校验离屏层尺寸与新度量一致（不一致说明度量漂移，降级全量）
        ensureClueLayers(metrics());
        if (clueOK) {
          for (const r of clueUpdate.rows || []) paintClueRow(r);
          for (const c of clueUpdate.cols || []) paintClueCol(c);
        }
      }
      requestDraw();
    }
    function setLevel(sz) { size = sz; clueOK = false; fitToScreen(); }
    function setClueScale(v) {
      clueScale = v || 1;
      clueOK = false;   // 度量变化
      clampOffset();
      requestDraw();
    }
    function invalidateClues() { clueOK = false; requestDraw(); }

    window.addEventListener('resize', () => { resize(); });

    return {
      resize, draw, requestDraw, setData, setLevel, setClueScale, invalidateClues,
      cellAt, clueAt, fitToScreen, zoomAt, panBy, clampOffset,
      get scale() { return scale; },
      get metrics() { return metrics(); },
      get offset() { return { ox, oy }; },   // 调试/自动化用
      get size() { return size; },           // 输入层轴向锁定需要
    };
  }

  NG.createRenderer = createRenderer;
})();
