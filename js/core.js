/* core.js — 游戏核心逻辑：提示计算、变灰判定、行列锁定、胜利判定 */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  /** 空状态 */
  function createState(size) {
    return { size, cells: new Uint8Array(size * size) }; // 0=空 1=填色 2=×
  }

  /**
   * 开局自动预填（幂等，可对恢复的存档重复执行）：
   * 提示为空/[0] → 整行/列自动标 ×；提示 [size]（与棋盘规格相同）→ 整行/列自动填色。
   * 预填不进撤销栈（开局基线状态）；锁定由 computeLocks 自然推导。
   */
  function applyAutoPreset(state, clues) {
    const { size, cells } = state;
    const isEmpty = (cl) => cl.length === 0 || (cl.length === 1 && cl[0] === 0);
    const isFull = (cl) => cl.length === 1 && cl[0] === size;
    for (let r = 0; r < size; r++) {
      const cl = clues.rows[r];
      if (isFull(cl)) {
        for (let c = 0; c < size; c++) if (cells[r * size + c] !== 2) cells[r * size + c] = 1;
      } else if (isEmpty(cl)) {
        for (let c = 0; c < size; c++) if (cells[r * size + c] === 0) cells[r * size + c] = 2;
      }
    }
    for (let c = 0; c < size; c++) {
      const cl = clues.cols[c];
      if (isFull(cl)) {
        for (let r = 0; r < size; r++) if (cells[r * size + c] !== 2) cells[r * size + c] = 1;
      } else if (isEmpty(cl)) {
        for (let r = 0; r < size; r++) if (cells[r * size + c] === 0) cells[r * size + c] = 2;
      }
    }
  }

  /** 序列（0/1 数组）→ 连续填色块长度数组 */
  function runsOf(line) {
    const runs = [];
    let c = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === 1) c++;
      else if (c > 0) { runs.push(c); c = 0; }
    }
    if (c > 0) runs.push(c);
    return runs;
  }

  /** 位串（0/1 字符）→ Uint8Array */
  function bitsToCells(bits) {
    const arr = new Uint8Array(bits.length);
    for (let i = 0; i < bits.length; i++) arr[i] = bits.charCodeAt(i) - 48;
    return arr;
  }

  /** 解 → 行/列提示 */
  function cluesFromSolution(solution, size) {
    const rows = [], cols = [];
    for (let r = 0; r < size; r++) {
      const line = [];
      for (let c = 0; c < size; c++) line.push(solution[r * size + c]);
      rows.push(runsOf(line));
    }
    for (let c = 0; c < size; c++) {
      const line = [];
      for (let r = 0; r < size; r++) line.push(solution[r * size + c]);
      cols.push(runsOf(line));
    }
    return { rows, cols };
  }

  /** 取一条线：isRow=true 时 index 为行号 */
  function lineOf(cells, size, index, isRow) {
    const line = new Array(size);
    for (let k = 0; k < size; k++) line[k] = cells[isRow ? index * size + k : k * size + index];
    return line;
  }

  /**
   * 行/列满足判定：当前填色块模式与提示完全一致
   * （提示由 cluesFromSolution 产出，天然不含 0，无需再过滤）
   * @returns {boolean} 模式吻合（与位置正确与否无关）
   */
  function lineMatches(cells, clue, size, index, isRow) {
    const runs = runsOf(lineOf(cells, size, index, isRow));
    const target = clue || [];
    if (runs.length !== target.length) return false;
    for (let i = 0; i < runs.length; i++) if (runs[i] !== target[i]) return false;
    return true;
  }

  /** 线内极大填色块：{start, len, fixed}，fixed = 两端被 ×/边缘围住（已定型） */
  function runsDetail(line, size) {
    const runs = [];
    let i = 0;
    while (i < size) {
      if (line[i] === 1) {
        const start = i;
        while (i < size && line[i] === 1) i++;
        const leftFixed = start === 0 || line[start - 1] === 2;
        const rightFixed = i === size || line[i] === 2;
        runs.push({ start, len: i - start, fixed: leftFixed && rightFixed });
      } else i++;
    }
    return runs;
  }

  /**
   * 必然完成（带 × 约束的兼容排列 DP）
   * 约束：填色格必须为 1、× 格必须为 0、空格自由。
   * 返回每块可能起点数组（starts[k] 为空集表示与当前约束矛盾）
   */
  function certainStarts(line, size, target) {
    const n = target.length;
    // left[i][k]：前 i 格容纳前 k 块且第 i-1 格可视为空
    const left = Array.from({ length: size + 1 }, () => new Uint8Array(n + 1));
    left[0][0] = 1;
    for (let i = 0; i < size; i++) {
      for (let k = 0; k <= n; k++) {
        if (!left[i][k]) continue;
        if (line[i] !== 1) left[i + 1][k] = 1;           // 该格为空（× 或自由）
        if (k < n) {                                      // 放块 k
          const len = target[k];
          let ok = i + len <= size;
          for (let j = i; ok && j < i + len; j++) if (line[j] === 2) ok = false;
          if (ok) {
            if (i + len === size) left[size][k + 1] = 1;
            else if (line[i + len] !== 1) left[i + len + 1][k + 1] = 1; // 块后一格空
          }
        }
      }
    }
    // right[i][k]：[i, size) 容纳块 k..n-1
    const right = Array.from({ length: size + 2 }, () => new Uint8Array(n + 1));
    right[size][n] = 1;
    for (let i = size - 1; i >= 0; i--) {
      for (let k = n; k >= 0; k--) {
        if (line[i] !== 1 && right[i + 1][k]) right[i][k] = 1;   // 该格空
        if (k < n && !right[i][k]) {                             // 块 k 从 i 开始
          const len = target[k];
          let ok = i + len <= size;
          for (let j = i; ok && j < i + len; j++) if (line[j] === 2) ok = false;
          if (ok) {
            if (i + len === size) right[i][k] = right[size][k + 1];
            else if (line[i + len] !== 1) right[i][k] = right[i + len + 1][k + 1];
          }
        }
      }
    }
    // 块 k 起点 s 可行 = left[s][k] && 从 s 放块 k 后右侧可容纳剩余
    const starts = [];
    for (let k = 0; k < n; k++) {
      const set = [];
      const len = target[k];
      for (let s = 0; s + len <= size; s++) {
        if (!left[s][k]) continue;
        let tailOk;
        if (s + len === size) tailOk = right[size][k + 1];
        else if (line[s + len] === 1) tailOk = 0;
        else tailOk = right[s + len + 1][k + 1];
        if (tailOk) set.push(s);
      }
      starts.push(set);
    }
    return starts;
  }

  /**
   * 变灰与警示判定（每行/列独立，纯函数）
   * @param {string} mode 'strict'|'loose'
   *   共同规则 G1 必然完成：× 约束下数字块区间唯一且全为填色 → 变灰
   *   strict 附加：S3a 唯一数字有等长块 → 灰；
   *               S3b 重复数字：等长块数==出现次数 → 全灰；
   *               超载时仅当"定型块数==出现次数" → 灰定型块
   *   loose 附加：W2 数字可能范围内恰有 1 个等长块 → 灰
   *   警示：块长超最大值 或 块数超数字总数
   * @returns {{gray: boolean[], alert: boolean}} gray 下标对应过滤 0 后的提示数字
   */
  function grayState(cells, clue, size, index, isRow, mode) {
    const target = clue || [];   // cluesFromSolution 产出，天然无 0
    const line = lineOf(cells, size, index, isRow);
    const runs = runsDetail(line, size);
    const n = target.length;
    const gray = new Array(n).fill(false);

    // 警示
    const maxClue = n ? Math.max(...target) : 0;
    const alert = runs.some((r) => r.len > maxClue) || runs.length > n;

    // G1 必然完成
    const starts = certainStarts(line, size, target);
    for (let k = 0; k < n; k++) {
      if (starts[k].length !== 1) continue;
      const s = starts[k][0], len = target[k];
      let full = true;
      for (let j = s; j < s + len; j++) if (line[j] !== 1) { full = false; break; }
      if (full) gray[k] = true;
    }

    if (mode === 'loose') {
      // W2 范围匹配：起点范围 [minStart, maxStart]（纯提示结构）
      let min = 0;
      for (let k = 0; k < n; k++) {
        const max = size - (n - k ? target.slice(k + 1).reduce((a, b) => a + b + 1, 0) : 0) - target[k];
        const cands = runs.filter((r) => r.len === target[k] && r.start >= min && r.start <= max);
        if (cands.length === 1) gray[k] = true;
        min += target[k] + 1;
      }
    } else {
      // S3a / S3b
      const byVal = new Map(); // 数值 → 实例下标列表
      for (let k = 0; k < n; k++) {
        if (!byVal.has(target[k])) byVal.set(target[k], []);
        byVal.get(target[k]).push(k);
      }
      for (const [v, idxs] of byVal) {
        const matching = runs.filter((r) => r.len === v);
        const m = idxs.length;
        if (m === 1) {
          if (matching.length === 1) gray[idxs[0]] = true;      // S3a
        } else if (matching.length === m) {
          for (const k of idxs) gray[k] = true;                  // S3b 数量吻合
        } else if (matching.length > m) {
          const fixed = matching.filter((r) => r.fixed);
          if (fixed.length === m) {                              // 超载但可区分
            for (const k of idxs) gray[k] = true;
          }
        }
      }
    }
    return { gray, alert };
  }

  /**
   * 行/列正确判定：填色格与唯一解逐格一致（调用前提：lineMatches 已为 true）
   */
  function lineCorrect(cells, solution, size, index, isRow) {
    for (let k = 0; k < size; k++) {
      const i = isRow ? index * size + k : k * size + index;
      if ((cells[i] === 1 ? 1 : 0) !== (solution[i] ? 1 : 0)) return false;
    }
    return true;
  }

  /**
   * 全量推导锁定状态（纯函数，撤销后重算天然一致）
   * 行/列"模式吻合且与解一致" → 该行/列所有格锁定
   * @returns {Uint8Array} locked 标记
   */
  function computeLocks(state, clues, solution) {
    const { size, cells } = state;
    const locked = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) {
      if (lineMatches(cells, clues.rows[r], size, r, true) &&
          lineCorrect(cells, solution, size, r, true)) {
        for (let c = 0; c < size; c++) locked[r * size + c] = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      if (lineMatches(cells, clues.cols[c], size, c, false) &&
          lineCorrect(cells, solution, size, c, false)) {
        for (let r = 0; r < size; r++) locked[r * size + c] = 1;
      }
    }
    return locked;
  }

  /** 胜利判定：填色与唯一解完全一致 */
  function isSolved(state, solution) {
    for (let i = 0; i < state.cells.length; i++) {
      if ((state.cells[i] === 1 ? 1 : 0) !== (solution[i] ? 1 : 0)) return false;
    }
    return true;
  }

  /** 完成度：正确填色数 / 应填总数 */
  function progress(state, solution) {
    let filled = 0, total = 0;
    for (let i = 0; i < solution.length; i++) {
      if (solution[i]) {
        total++;
        if (state.cells[i] === 1) filled++;
      }
    }
    return { filled, total };
  }

  /** 难度评级：按尺寸分 1~5 星（兜底，精确评级见 levels.js 的分位数评级） */
  function difficultyOf(size) {
    return { 5: 1, 10: 2, 15: 3, 20: 4, 25: 5 }[size] || 1;
  }

  /** 解的求解特征原始分：块密度 + 碎线率 + 填色密度，供同尺寸内分档排序 */
  function solutionScore(solution, size) {
    const cells = typeof solution === 'string' ? bitsToCells(solution) : solution;
    let blocks = 0, singles = 0, filled = 0;
    for (let r = 0; r < size; r++) {
      let c = 0;
      for (let k = 0; k <= size; k++) {
        const v = k < size && cells[r * size + k] ? 1 : 0;
        if (v) c++;
        else if (c) { blocks++; if (c === 1) singles++; c = 0; }
      }
    }
    for (let col = 0; col < size; col++) {
      let c = 0;
      for (let k = 0; k <= size; k++) {
        const v = k < size && cells[k * size + col] ? 1 : 0;
        if (v) c++;
        else if (c) { blocks++; if (c === 1) singles++; c = 0; }
      }
    }
    for (let i = 0; i < cells.length; i++) if (cells[i]) filled++;
    const bpl = blocks / (2 * size);              // 每线平均块数
    const frag = blocks ? singles / blocks : 0;   // 碎线率（长度 1 的块占比）
    const density = filled / (size * size);
    return bpl * 2 + frag * 3 + density;
  }

  NG.core = {
    createState,
    applyAutoPreset,
    runsOf,
    bitsToCells,
    cluesFromSolution,
    lineOf,
    lineMatches,
    grayState,
    lineCorrect,
    computeLocks,
    isSolved,
    progress,
    difficultyOf,
    solutionScore,
  };
})();
