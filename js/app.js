/* app.js — 界面串联：视图管理、Game 控制器（撤销/重做、计时、存档）、胜利流程 */
(function () {
  'use strict';
  const NG = window.NG;
  const $ = (sel) => document.querySelector(sel);

  /* ---------- 主题（CSS 变量读取 + 缓存） ---------- */
  NG.theme = {
    cache: {},
    color(name) {
      if (!(name in this.cache)) {
        this.cache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      }
      return this.cache[name];
    },
    refresh() { this.cache = {}; },
  };
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener('change', onTheme) : mq.addListener(onTheme));
  function onTheme() { NG.theme.refresh(); if (renderer) renderer.invalidateClues(); }

  /* ---------- 视图切换 ---------- */
  const views = ['home', 'game', 'about', 'stats', 'stickers'];
  let curView = 'home';
  function show(name) {
    for (const v of views) $('#view-' + v).classList.toggle('active', v === name);
    curView = name;
    game.timerRun = name === 'game' && !game.solved;
    if (name === 'game') {
      renderer.resize();
      // 桌面端聚焦隐藏密码框：密码框系统级禁用输入法，快捷键不再被拼音拦截
      if (imeTrap && matchMedia('(hover: hover) and (pointer: fine)').matches) {
        imeTrap.focus({ preventScroll: true });
      }
    } else if (imeTrap) imeTrap.blur();
  }

  /* ---------- 主页 ---------- */
  let curSize = null;
  let homeToken = 0; // 防快速切 tab 的渲染竞态
  let homePager = null; // { ensure(idx), hideDone } 供「下一个未完成」滚动定位
  async function renderHome() {
    const sizes = NG.levels.sizes();
    if (!curSize || !sizes.includes(curSize)) curSize = sizes[0];
    const token = ++homeToken;
    // tabs 先渲染（不依赖数据）
    const tabs = $('#sizeTabs');
    tabs.innerHTML = '';
    for (const s of sizes) {
      const b = document.createElement('button');
      b.className = 'tab' + (s === curSize ? ' on' : '');
      b.textContent = s + '×' + s;
      b.addEventListener('click', () => { curSize = s; renderHome(); });
      tabs.appendChild(b);
    }
    // 表情包入口：25×25 右侧独立页面（评估样张）
    const stickerBtn = document.createElement('button');
    stickerBtn.className = 'tab sticker';
    stickerBtn.textContent = '表情包';
    stickerBtn.addEventListener('click', () => { renderStickers(); show('stickers'); });
    tabs.appendChild(stickerBtn);
    // 隐藏已完成开关
    const hideDone = !!NG.storage.data.settings.hideDone;
    const hideBtn = document.createElement('button');
    hideBtn.className = 'tab filter' + (hideDone ? ' on' : '');
    hideBtn.textContent = '隐藏已完成';
    hideBtn.addEventListener('click', () => {
      NG.storage.setSetting('hideDone', !hideDone);
      renderHome();
    });
    tabs.appendChild(hideBtn);
    // 图标关卡按需加载：当前规格 + 继续上局所属规格
    const last = NG.storage.data.last;
    const lastSize = last ? Number((last.match(/\d+/) || [])[0]) : null;
    const loads = [NG.levels.ensureIcons(curSize)];
    if (lastSize && sizes.includes(lastSize)) loads.push(NG.levels.ensureIcons(lastSize));
    await Promise.all(loads);
    if (token !== homeToken) return; // 已切换到其他规格，放弃本次渲染
    const base = NG.levels.bySize(curSize);
    const all = hideDone
      ? base.filter((lv) => { const r = NG.storage.levelState(lv.id); return !(r && r.done); })
      : base;
    const grid = $('#levelGrid');
    grid.innerHTML = '';
    const PAGE = 120;
    let shown = 0;
    function appendPage() {
      const end = Math.min(all.length, shown + PAGE);
      for (; shown < end; shown++) {
        const lv = all[shown];
        const rec = NG.storage.levelState(lv.id);
        const card = document.createElement('button');
        card.className = 'lv' + (rec && rec.done ? ' done' : '');
        const th = document.createElement('canvas');
        th.width = 96; th.height = 96;
        drawThumb(th, lv, rec && rec.done);
        const name = document.createElement('span');
        name.textContent = lv.name;
        const diff = document.createElement('small');
        diff.textContent = '★'.repeat(lv.difficulty);
        card.append(th, name, diff);
        card.addEventListener('click', () => openLevel(lv, !!rec));
        grid.appendChild(card);
      }
      const more = $('#btnMore');
      if (shown < all.length) {
        more.style.display = '';
        more.textContent = '加载更多（' + all.length + ' 关，已显示 ' + shown + '）';
        more.onclick = appendPage;
      } else more.style.display = 'none';
    }
    appendPage();
    homePager = {
      ensure(idx) { while (shown <= idx && shown < all.length) appendPage(); },
      hideDone,
    };
    // 继续上局
    const cont = $('#btnContinue');
    const lastId = NG.storage.data.last;
    const lastLv = lastId && NG.levels.find(lastId);
    const lastRec = lastId && NG.storage.levelState(lastId);
    if (lastLv && lastRec && lastRec.state && !lastRec.done) {
      cont.style.display = '';
      cont.textContent = '继续：' + lastLv.name + '（' + lastLv.size + '×' + lastLv.size + '）';
      cont.onclick = () => openLevel(lastLv, true);
    } else cont.style.display = 'none';
  }

  function drawThumb(canvas, lv, done) {
    const ctx = canvas.getContext('2d');
    const n = lv.size;
    const sol = NG.core.bitsToCells(lv.solution);
    const u = canvas.width / n;
    const showSolution = done || debugThumbs; // debug 模式下未完成关卡也显示答案
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = NG.theme.color('--board-bg');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (showSolution) {
      ctx.fillStyle = done ? NG.theme.color('--brand') : NG.theme.color('--debug-fill');
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (sol[r * n + c]) ctx.fillRect(c * u, r * u, u + 0.5, u + 0.5);
      }
    } else {
      ctx.fillStyle = NG.theme.color('--text-faint');
      ctx.font = '600 ' + canvas.width * 0.42 + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', canvas.width / 2, canvas.height / 2);
    }
  }

  /* ---------- 表情包关卡页 ---------- */
  function stickerPreviewMode() {
    return $('#stickerPreviewSel').value; // auto | sticker | thumb
  }
  function renderStickers() {
    const grid = $('#stickerGrid');
    const all = NG.levels.stickerBySize(25);
    grid.innerHTML = '';
    const mode = stickerPreviewMode();
    const PAGE = 120;
    let shown = 0;
    function appendPage() {
      const end = Math.min(all.length, shown + PAGE);
      for (; shown < end; shown++) {
        const lv = all[shown];
        const rec = NG.storage.levelState(lv.id);
        const card = document.createElement('button');
        card.className = 'lv' + (rec && rec.done ? ' done' : '');
        if (mode === 'sticker' || (mode === 'auto' && !(rec && rec.done))) {
          const img = document.createElement('img');
          img.src = lv.img;
          img.alt = lv.name;
          img.loading = 'lazy';
          card.appendChild(img);
        } else {
          const th = document.createElement('canvas');
          th.width = th.height = 72;
          drawThumb(th, lv, true); // 缩略图模式直接展示答案缩略图
          card.appendChild(th);
        }
        const name = document.createElement('span');
        name.textContent = lv.name;
        const diff = document.createElement('small');
        diff.textContent = '★'.repeat(lv.difficulty || NG.core.difficultyOf(lv.size));
        card.append(name, diff);
        card.addEventListener('click', () => openLevel(lv, !!rec, 'stickers'));
        grid.appendChild(card);
      }
      const more = $('#btnStickerMore');
      if (shown < all.length) {
        more.style.display = '';
        more.textContent = '加载更多（' + all.length + ' 张，已显示 ' + shown + '）';
        more.onclick = appendPage;
      } else more.style.display = 'none';
    }
    appendPage();
    if (!all.length) grid.innerHTML = '<p class="ver">暂无表情包关卡</p>';
  }
  $('#stickerPreviewSel').value = NG.storage.data.settings.stickerPreview || 'auto';
  $('#stickerPreviewSel').addEventListener('change', () => {
    NG.storage.setSetting('stickerPreview', $('#stickerPreviewSel').value);
    renderStickers();
  });
  $('#btnStickersBack').addEventListener('click', () => { renderHome(); show('home'); });

  /* ---------- 游戏控制器 ---------- */
  const renderer = NG.createRenderer($('#board'));
  let mode = 'fill';          // fill | mark
  let curTx = null;           // 当前一笔事务
  let debugReveal = false;    // 关卡内 L 键：淡绿显影答案
  let debugThumbs = false;    // 选关页 L 键：未完成关卡显示缩略图
  function toggleDebugReveal() {
    debugReveal = !debugReveal;
    renderer.setData(currentData());
  }
  function toggleDebugThumbs() {
    debugThumbs = !debugThumbs;
    renderHome();
  }

  const game = {
    level: null, solution: null, clues: null,
    state: null, locks: null,
    rowDone: [], colDone: [],   // 行/列完成布尔（locks = rowDone ∪ colDone 的投影）
    grayRows: [], grayCols: [], alertRows: [], alertCols: [],
    undoStack: [], redoStack: [],
    solved: false, elapsed: 0, timerRun: false, timerId: 0,
    hover: -1,
    pin: null,   // 钉选高亮 'r3' / 'c7' | null
  };
  // 只读调试句柄（控制台排查/自动化验证用；仅引用不劫持）
  NG.debug = { game, renderer, get mode() { return mode; } };

  let backTarget = 'home'; // 游戏内返回目标：home | stickers（记录进入来源）
  function openLevel(lv, resume, from) {
    backTarget = from || 'home';   // 每次进关都重置：未显式指定来源的一律返回主页
    game.level = lv;
    game.solution = NG.core.bitsToCells(lv.solution);
    game.clues = NG.core.cluesFromSolution(game.solution, lv.size);
    game.state = NG.core.createState(lv.size);
    NG.core.applyAutoPreset(game.state, game.clues);
    game.undoStack = []; game.redoStack = [];
    game.solved = false; game.elapsed = 0; game.hover = -1; game.pin = null;

    const rec = resume && NG.storage.levelState(lv.id);
    if (rec && rec.state) {
      const saved = NG.core.bitsToCells(rec.state);
      game.state.cells.set(saved);
      // 旧存档可能缺少开局预填规则，幂等补一次
      NG.core.applyAutoPreset(game.state, game.clues);
      game.elapsed = rec.time || 0;
    }
    refresh();

    $('#gameName').textContent = lv.name + ' · ' + lv.size + '×' + lv.size;
    $('#winOverlay').classList.remove('show');
    show('game');
    renderer.setLevel(lv.size);
    startTimer();
  }

  /* 计时：墙钟差值累加（后台节流不再少计），页面隐藏即暂停 */
  let lastTs = 0, carryMs = 0, shownSec = -1;
  function startTimer() {
    if (game.timerId) clearInterval(game.timerId);
    lastTs = Date.now(); carryMs = 0;
    game.timerId = setInterval(() => {
      const now = Date.now();
      if (game.timerRun && curView === 'game' && !document.hidden && !game.solved) {
        carryMs += now - lastTs;
        while (carryMs >= 1000) { game.elapsed++; carryMs -= 1000; }
        if (game.elapsed !== shownSec) { shownSec = game.elapsed; updateHUD(); }
      } else carryMs = 0;
      lastTs = now;
    }, 500);
    updateHUD();
  }
  document.addEventListener('visibilitychange', () => {
    // 切后台即暂停计时并把进度落盘
    if (document.hidden && game.level && !game.solved) {
      NG.storage.saveLevelState(game.level.id, { state: game.state.cells.join(''), time: game.elapsed });
    }
  });

  function fmtTime(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function updateHUD() {
    $('#gameTimer').textContent = fmtTime(game.elapsed);
    const p = NG.core.progress(game.state, game.solution);
    $('#gameProgress').textContent = p.filled + '/' + p.total;
    $('#btnUndo').disabled = game.undoStack.length === 0;
    $('#btnRedo').disabled = game.redoStack.length === 0;
  }

  /**
   * 刷新：锁定推导、变灰、警示、存档、渲染、胜利检测
   * @param {boolean} persist 是否写存档（paint 高频路径传 false，由 paintEnd 统一落盘）
   * @param {number} [dirty] 被改格子的 index（增量模式：只重推该行+该列）
   */
  function refresh(persist, dirty) {
    const { size, cells } = game.state;
    const gm = NG.storage.data.settings.grayMode || 'strict';
    if (dirty == null) {
      game.locks = NG.core.computeLocks(game.state, game.clues, game.solution);
      game.rowDone = [];
      game.colDone = [];
      game.grayRows = []; game.grayCols = [];
      game.alertRows = []; game.alertCols = [];
      for (let r = 0; r < size; r++) {
        game.rowDone.push(NG.core.lineMatches(cells, game.clues.rows[r], size, r, true) &&
          NG.core.lineCorrect(cells, game.solution, size, r, true));
        const g = NG.core.grayState(cells, game.clues.rows[r], size, r, true, gm);
        game.grayRows.push(g.gray);
        game.alertRows.push(g.alert);
      }
      for (let c = 0; c < size; c++) {
        game.colDone.push(NG.core.lineMatches(cells, game.clues.cols[c], size, c, false) &&
          NG.core.lineCorrect(cells, game.solution, size, c, false));
        const g = NG.core.grayState(cells, game.clues.cols[c], size, c, false, gm);
        game.grayCols.push(g.gray);
        game.alertCols.push(g.alert);
      }
      renderer.setData(currentData(), 'all');
    } else {
      // 增量：锁 = 行完成 ∪ 列完成 的并集投影。用完成布尔差量更新，
      // 只刷新状态确实变化的行/列，避免误清其他线贡献的锁（自动 × 丢失 bug）
      const r = (dirty / size) | 0, c = dirty % size;
      const rd1 = NG.core.lineMatches(cells, game.clues.rows[r], size, r, true) &&
        NG.core.lineCorrect(cells, game.solution, size, r, true);
      const cd1 = NG.core.lineMatches(cells, game.clues.cols[c], size, c, false) &&
        NG.core.lineCorrect(cells, game.solution, size, c, false);
      const rd0 = game.rowDone[r], cd0 = game.colDone[c];
      if (rd0 !== rd1) {
        game.rowDone[r] = rd1;
        for (let k = 0; k < size; k++) game.locks[r * size + k] = rd1 ? 1 : (game.colDone[k] ? 1 : 0);
      }
      if (cd0 !== cd1) {
        game.colDone[c] = cd1;
        for (let k = 0; k < size; k++) game.locks[k * size + c] = cd1 ? 1 : (game.rowDone[k] ? 1 : 0);
      }
      const gr = NG.core.grayState(cells, game.clues.rows[r], size, r, true, gm);
      game.grayRows[r] = gr.gray; game.alertRows[r] = gr.alert;
      const gc = NG.core.grayState(cells, game.clues.cols[c], size, c, false, gm);
      game.grayCols[c] = gc.gray; game.alertCols[c] = gc.alert;
      renderer.setData(currentData(), { rows: [r], cols: [c] });
    }
    updateHUD();
    if (persist !== false && !game.solved) {
      NG.storage.saveLevelState(game.level.id, { state: cells.join(''), time: game.elapsed });
    }
    if (!game.solved && NG.core.isSolved(game.state, game.solution)) win();
  }

  function currentData() {
    return {
      cells: game.state.cells,
      clues: game.clues,
      locks: game.locks,
      grayRows: game.grayRows,
      grayCols: game.grayCols,
      alertRows: game.alertRows,
      alertCols: game.alertCols,
      hover: game.hover,
      pin: game.pin,
      solved: game.solved,
      solution: game.solution,
      debugSolution: debugReveal ? game.solution : null,
    };
  }

  /* ---------- 输入回调 ---------- */
  function decide(index, button) {
    if (game.solved || game.locks[index]) return null;
    const cur = game.state.cells[index];
    if (button === 2 || mode === 'mark') return cur === 2 ? 0 : 2;
    return cur === 1 ? 0 : 1;   // fill 模式：非填色 → 填色，填色 → 清空
  }

  NG.attachInput($('#board'), renderer, {
    decide,
    paintBegin() { curTx = []; },
    paint(index, value) {
      if (game.solved || game.locks[index]) return;
      if (game.state.cells[index] === value) return;
      if (curTx) curTx.push({ i: index, from: game.state.cells[index], to: value });
      game.state.cells[index] = value;
      if (NG.storage.data.settings.vibrate && navigator.vibrate) navigator.vibrate(6);
      refresh(false, index);   // 高频路径：不落盘、增量重推
    },
    paintEnd() {
      if (curTx && curTx.length) {
        game.undoStack.push(curTx);
        game.redoStack = [];
        NG.storage.saveLevelState(game.level.id, { state: game.state.cells.join(''), time: game.elapsed });
      }
      curTx = null;
      updateHUD();
    },
    hover(index) {
      if (game.hover === index) return;
      game.hover = index;
      renderer.setData(currentData());   // 提示层已缓存，只重绘棋盘
    },
    cluePin(key) {
      game.pin = game.pin === key ? null : key;
      renderer.setData(currentData());
    },
    axisLock() {
      return NG.storage.data.settings.axisLock !== false;   // 默认开启
    },
  });

  /* ---------- 撤销 / 重做 ---------- */
  function applyTx(tx, dir) {
    for (let k = 0; k < tx.length; k++) {
      const op = tx[dir > 0 ? k : tx.length - 1 - k];
      game.state.cells[op.i] = dir > 0 ? op.to : op.from;
    }
    refresh();
  }
  $('#btnUndo').addEventListener('click', () => {
    if (!game.undoStack.length || game.solved) return;
    const tx = game.undoStack.pop();
    applyTx(tx, -1);
    game.redoStack.push(tx);
    updateHUD();
  });
  $('#btnRedo').addEventListener('click', () => {
    if (!game.redoStack.length || game.solved) return;
    const tx = game.redoStack.pop();
    applyTx(tx, 1);
    game.undoStack.push(tx);
    updateHUD();
  });

  /* ---------- 工具栏 ---------- */
  const toggleMode = () => {
    mode = mode === 'fill' ? 'mark' : 'fill';
    $('#btnMode').textContent = mode === 'fill' ? '填色' : '标记×';
    $('#btnMode').classList.toggle('mark', mode === 'mark');
  };
  // F 键切换填色/标记（桌面端）；L 键 debug 显影（选关页显示未完成缩略图 / 关卡内淡绿标出答案）
  const imeTrap = $('#imeTrap');
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'l' || e.key === 'L') {
      if (curView === 'game') { toggleDebugReveal(); e.preventDefault(); }
      else if (curView === 'home') { toggleDebugThumbs(); e.preventDefault(); }
      return;
    }
    if (curView !== 'game') return;
    if (e.key === 'f' || e.key === 'F') { toggleMode(); e.preventDefault(); }
  });
  $('#btnMode').addEventListener('click', toggleMode);
  $('#btnZoomIn').addEventListener('click', () => {
    const r = $('#board').getBoundingClientRect();
    renderer.zoomAt(r.width / 2, r.height / 2, 1.25);
  });
  $('#btnZoomOut').addEventListener('click', () => {
    const r = $('#board').getBoundingClientRect();
    renderer.zoomAt(r.width / 2, r.height / 2, 0.8);
  });
  $('#btnFit').addEventListener('click', () => renderer.fitToScreen());
  // 提示数字大小循环：1 → 1.3 → 1.6 → 1
  const FONT_STEPS = [1, 1.3, 1.6];
  let fontIdx = Math.max(0, FONT_STEPS.indexOf(NG.storage.data.settings.clueScale || 1));
  function applyFont() {
    const s = FONT_STEPS[fontIdx];
    renderer.setClueScale(s);
    $('#btnFont').textContent = 'A' + '+'.repeat(fontIdx);
    NG.storage.setSetting('clueScale', s);
  }
  $('#btnFont').addEventListener('click', () => {
    fontIdx = (fontIdx + 1) % FONT_STEPS.length;
    applyFont();
  });
  applyFont();
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('清空当前进度，重新开始本关？')) return;
    game.state.cells.fill(0);
    game.undoStack = []; game.redoStack = [];
    game.elapsed = 0;
    refresh();
    NG.storage.clearLevel(game.level.id);
  });
  $('#btnBack').addEventListener('click', () => {
    if (backTarget === 'stickers') renderStickers();
    else renderHome();
    show(backTarget);
  });

  /* ---------- 胜利 ---------- */
  function win() {
    game.solved = true;
    game.timerRun = false;
    NG.storage.markDone(game.level.id, game.elapsed);
    refresh(false);
    $('#winName').textContent = game.level.name;
    $('#winMeta').textContent = game.level.size + '×' + game.level.size +
      (game.level.author ? ' · 图案：' + game.level.author : '') +
      ' · 用时 ' + fmtTime(game.elapsed);
    // 完成图案缩略图（随机关不入存档，关掉弹窗就看不到了）
    const winThumb = $('#winThumb');
    winThumb.innerHTML = '';
    const th = document.createElement('canvas');
    th.width = 144; th.height = 144;
    drawThumb(th, game.level, true);
    winThumb.appendChild(th);
    $('#winOverlay').classList.add('show');
    if (NG.storage.data.settings.vibrate && navigator.vibrate) navigator.vibrate([60, 40, 60]);
  }
  $('#btnWinBack').addEventListener('click', () => {
    $('#winOverlay').classList.remove('show');
    if (backTarget === 'stickers') renderStickers();
    else renderHome();
    show(backTarget);
  });
  $('#btnWinRandom').addEventListener('click', () => {
    $('#winOverlay').classList.remove('show');
    const lv = NG.levels.generate(game.level.size);
    if (lv) openLevel(lv, false);
  });

  /* ---------- 随机生成 ---------- */
  async function startRandom(size, btn) {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';
    const lv = await NG.levels.generateAsync(size);
    btn.disabled = false;
    btn.textContent = prev;
    if (lv) openLevel(lv, false);
    else alert('生成失败，请重试');
  }
  $('#btnRandom').addEventListener('click', () => {
    startRandom(curSize, $('#btnRandom'));
  });
  // 跳到本规格下一个未完成关卡（隐藏已完成时即列表第一项）
  $('#btnNext').addEventListener('click', () => {
    const base = NG.levels.bySize(curSize);
    let target = -1;
    for (let i = 0; i < base.length; i++) {
      const r = NG.storage.levelState(base[i].id);
      if (!(r && r.done)) { target = i; break; }
    }
    if (target < 0) { alert('当前规格已全部完成！'); return; }
    if (!homePager) return;
    const idx = homePager.hideDone ? 0 : target;
    homePager.ensure(idx);
    const card = $('#levelGrid').children[idx];
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1800);
    }
  });
  // 游戏内"换一局"：生成同尺寸新随机关
  $('#btnNewRandom').addEventListener('click', () => {
    startRandom(game.level.size, $('#btnNewRandom'));
  });

  /* ---------- 统计页 ---------- */
  function fmtDuration(s) {
    if (s < 60) return s + ' 秒';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? h + ' 小时 ' + m + ' 分' : m + ' 分钟';
  }
  function renderStats() {
    const all = NG.levels.allLevels();
    const bySize = {};
    let done = 0, totalTime = 0, best = null;
    for (const lv of all) {
      bySize[lv.size] = bySize[lv.size] || { total: 0, done: 0 };
      bySize[lv.size].total++;
      const rec = NG.storage.levelState(lv.id);
      if (rec && rec.done) {
        bySize[lv.size].done++;
        done++;
        totalTime += rec.time || 0;
        const t = rec.bestTime || rec.time;
        if (!best || t < best.time) best = { name: lv.name, size: lv.size, time: t };
      }
    }
    const randomWins = NG.storage.data.settings.randomWins || 0;

    const cards = $('#statCards');
    cards.innerHTML = '';
    const addCard = (label, value) => {
      const d = document.createElement('div');
      d.className = 'stat-card';
      d.innerHTML = '<b></b><span></span>';
      d.querySelector('b').textContent = value;
      d.querySelector('span').textContent = label;
      cards.appendChild(d);
    };
    addCard('已完成关卡', done + ' / ' + all.length);
    addCard('随机胜场', String(randomWins));
    addCard('累计用时', fmtDuration(totalTime));
    addCard('最快纪录', best ? fmtTime(best.time) : '—');
    if (best) $('#statNote').textContent = '最快纪录：' + best.name + '（' + best.size + '×' + best.size + '）';

    const wrap = $('#statSizes');
    wrap.innerHTML = '';
    for (const size of Object.keys(bySize).map(Number).sort((a, b) => a - b)) {
      const { total, done: dn } = bySize[size];
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = '<span class="stat-label"></span><div class="stat-bar"><i></i></div><span class="stat-num mono"></span>';
      row.querySelector('.stat-label').textContent = size + '×' + size;
      const bar = row.querySelector('.stat-bar i');
      bar.style.width = (total ? (dn / total) * 100 : 0) + '%';
      row.querySelector('.stat-num').textContent = dn + '/' + total;
      wrap.appendChild(row);
    }
  }
  $('#btnStats').addEventListener('click', async () => {
    // 统计需全量关卡：把尚未加载的规格包按需拉齐（含表情包），避免总数缺规格
    await Promise.all(NG.levels.sizes().map((s) => NG.levels.ensureIcons(s))
      .concat([NG.levels.ensureStickers(25)]));
    renderStats(); show('stats');
  });
  $('#btnStatsBack').addEventListener('click', () => { renderHome(); show('home'); });

  /* ---------- 进度导出/导入 ---------- */
  $('#btnExport').addEventListener('click', () => {
    const payload = { app: 'nonogram-save', version: 2, exportedAt: Date.now(), data: NG.storage.data };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nonogram-save-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    $('#syncNote').textContent = '已导出存档文件，发给另一台设备后在"导入进度"选择它即可合并。';
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#btnQrSync').addEventListener('click', openQrDialog);
  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const r = NG.storage.importData(payload);
      $('#syncNote').textContent = '合并完成：导入 ' + r.imported + ' 条关卡记录，新增完成 ' + r.newDone + ' 关。';
      renderStats();
    } catch (err) {
      $('#syncNote').textContent = '导入失败：' + (err && err.message ? err.message : '文件格式不正确');
    }
  });

  /* ---------- 二维码同步 ---------- */
  let qrChunks = [], qrIdx = 0, qrTimer = 0;
  let scanStream = null, scanTimer = 0;
  const scanBuf = new Map();

  async function deflateB64(str) {
    const cs = new CompressionStream('deflate-raw');
    const buf = new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(cs)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }
  async function inflateB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream('deflate-raw');
    return await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
  }

  async function buildQrChunks() {
    const payload = { app: 'nonogram-save', version: 2, exportedAt: Date.now(), data: NG.storage.data };
    const b64 = await deflateB64(JSON.stringify(payload));
    const LIMIT = 2600;
    if (b64.length <= LIMIT) return ['NGS|1|0|' + b64];
    const n = Math.ceil(b64.length / LIMIT);
    const out = [];
    for (let i = 0; i < n; i++) out.push('NGS|' + n + '|' + i + '|' + b64.slice(i * LIMIT, (i + 1) * LIMIT));
    return out;
  }

  function drawQr(text) {
    const qr = window.qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const canvas = $('#qrCanvas');
    const count = qr.getModuleCount();
    const cell = 6, quiet = 4;
    canvas.width = canvas.height = (count + quiet * 2) * cell;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
  }

  async function openQrDialog() {
    $('#qrView').style.display = '';
    $('#qrScanView').style.display = 'none';
    $('#btnQrToggle').textContent = '切换为扫码';
    $('#syncNote').textContent = '';
    stopScan();
    if (typeof CompressionStream === 'undefined') {
      $('#qrHint').textContent = '此浏览器不支持压缩，请使用文件导出';
      $('#qrCanvas').style.display = 'none';
      $('#qrOverlay').classList.add('show');
      return;
    }
    $('#qrCanvas').style.display = '';
    try {
      qrChunks = await buildQrChunks();
    } catch (err) {
      $('#qrHint').textContent = '生成失败：' + err.message;
      $('#qrOverlay').classList.add('show');
      return;
    }
    if (qrChunks.length > 24) {
      $('#qrHint').textContent = '进度数据过大（' + qrChunks.length + ' 个码），建议改用文件导出';
      qrChunks = [];
      $('#qrCanvas').style.display = 'none';
      $('#qrOverlay').classList.add('show');
      return;
    }
    qrIdx = 0;
    drawQr(qrChunks[0]);
    $('#qrHint').textContent = qrChunks.length > 1
      ? '多码分包 ' + 1 + '/' + qrChunks.length + '（自动轮播，扫码端会自动收齐合并）'
      : '扫码即可同步本机进度';
    $('#qrOverlay').classList.add('show');
    clearInterval(qrTimer);
    if (qrChunks.length > 1) {
      qrTimer = setInterval(() => {
        qrIdx = (qrIdx + 1) % qrChunks.length;
        drawQr(qrChunks[qrIdx]);
        $('#qrHint').textContent = '多码分包 ' + (qrIdx + 1) + '/' + qrChunks.length + '（自动轮播）';
      }, 2500);
    }
  }

  function closeQrDialog() {
    $('#qrOverlay').classList.remove('show');
    clearInterval(qrTimer);
    qrTimer = 0;
    stopScan();
  }

  async function handleScanText(text) {
    const parts = String(text).trim().split(/\s+/);
    let lastMsg = '';
    for (const part of parts) {
      const m = /^NGS\|(\d+)\|(\d+)\|(.+)$/.exec(part);
      if (!m) { lastMsg = '未识别到数织同步码'; continue; }
      const total = +m[1], idx = +m[2];
      scanBuf.set(idx, m[3]);
      if (scanBuf.size < total) {
        lastMsg = '已收到 ' + scanBuf.size + '/' + total + ' 包，继续…';
        continue;
      }
      // 收齐合并
      const b64 = Array.from({ length: total }, (_, i) => scanBuf.get(i)).join('');
      try {
        const payload = JSON.parse(await inflateB64(b64));
        const r = NG.storage.importData(payload);
        lastMsg = '同步完成：导入 ' + r.imported + ' 条记录，新增完成 ' + r.newDone + ' 关';
        scanBuf.clear();
        stopScan();
        renderStats();
      } catch (err) {
        lastMsg = '合并失败：' + (err && err.message ? err.message : '数据损坏');
        scanBuf.clear();
      }
      break;
    }
    $('#scanHint').textContent = lastMsg;
  }

  async function startScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#scanHint').textContent = '当前环境不支持相机（如直接打开本地文件），请用下方粘贴导入';
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
      $('#scanHint').textContent = '相机不可用（未授权或环境不支持），请用下方粘贴导入';
      return;
    }
    const video = $('#qrVideo');
    video.srcObject = scanStream;
    await video.play();
    $('#scanHint').textContent = '对准对方屏幕上的二维码';
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!scanStream) return;
      if (video.readyState >= 2) {
        const w = 420, h = Math.round(video.videoHeight / video.videoWidth * 420) || 420;
        cv.width = w; cv.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        try {
          const img = ctx.getImageData(0, 0, w, h);
          const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
          if (code && code.data) handleScanText(code.data);
        } catch (e) { /* 单帧失败忽略 */ }
      }
      scanTimer = setTimeout(tick, 180);
    };
    tick();
  }

  function stopScan() {
    scanStream = null;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = 0; }
    const video = $('#qrVideo');
    if (video.srcObject) {
      for (const track of video.srcObject.getTracks()) track.stop();
      video.srcObject = null;
    }
    scanBuf.clear();
  }

  $('#btnQrToggle').addEventListener('click', () => {
    const toScan = $('#qrView').style.display !== 'none';
    $('#qrView').style.display = toScan ? 'none' : '';
    $('#qrScanView').style.display = toScan ? '' : 'none';
    $('#btnQrToggle').textContent = toScan ? '切换为二维码' : '切换为扫码';
    if (toScan) startScan();
    else stopScan();
  });
  $('#btnQrClose').addEventListener('click', closeQrDialog);
  $('#qrOverlay').addEventListener('click', (e) => { if (e.target === $('#qrOverlay')) closeQrDialog(); });
  $('#btnQrPasteImport').addEventListener('click', () => {
    const text = $('#qrPasteText').value;
    if (text.trim()) handleScanText(text);
  });

  /* ---------- 关于页 ---------- */
  async function renderAbout() {
    // 署名汇总需要全量关卡，确保各规格图标包已加载
    await Promise.all([5, 10, 15, 20, 25].map((s) => NG.levels.ensureIcons(s)));
    const seen = new Map();
    for (const lv of NG.levels.allLevels()) {
      const key = (lv.source || '') + '|' + (lv.author || '') + '|' + (lv.license || '');
      if (!seen.has(key)) seen.set(key, { source: lv.source, author: lv.author, license: lv.license, n: 0 });
      seen.get(key).n++;
    }
    const ul = $('#creditList');
    ul.innerHTML = '';
    for (const it of seen.values()) {
      const li = document.createElement('li');
      li.textContent = (it.source || '内置') +
        (it.author ? ' — ' + it.author : '') +
        (it.license ? '（' + it.license + '）' : '') +
        ' · ' + it.n + ' 关';
      ul.appendChild(li);
    }
  }
  $('#btnAbout').addEventListener('click', () => { renderAbout(); show('about'); });
  $('#btnAboutBack').addEventListener('click', () => { renderHome(); show('home'); });

  /* ---------- 设置 ---------- */
  const vibrateChk = $('#vibrateChk');
  vibrateChk.checked = !!NG.storage.data.settings.vibrate;
  vibrateChk.addEventListener('change', () => {
    NG.storage.setSetting('vibrate', vibrateChk.checked);
  });
  // 变灰模式：strict（默认，无误导）/ loose（宽松，进度感强）
  const grayModeSel = $('#grayModeSel');
  grayModeSel.value = NG.storage.data.settings.grayMode || 'strict';
  grayModeSel.addEventListener('change', () => {
    NG.storage.setSetting('grayMode', grayModeSel.value);
    if (game.level && $('#view-game').classList.contains('active')) refresh();
  });
  // 轴向锁定（防手抖误涂）：默认开启，拖动时强制沿起点行/列
  const axisLockChk = $('#axisLockChk');
  axisLockChk.checked = NG.storage.data.settings.axisLock !== false;
  axisLockChk.addEventListener('change', () => {
    NG.storage.setSetting('axisLock', axisLockChk.checked);
  });

  /* ---------- PWA ---------- */
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    // updateViaCache:'none'：sw.js 更新检查绕过 HTTP 缓存，版本发布即时生效
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  /* ---------- 调试句柄（自动化测试用） ---------- */
  NG._game = game;

  /* ---------- 启动 ---------- */
  window.addEventListener('resize', () => { if ($('#view-game').classList.contains('active')) renderer.resize(); });
  NG.levels.ensureStickers(25); // 预载表情包关（统计/署名/独立页面共用，幂等）
  renderHome();
  show('home');
})();
