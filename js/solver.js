/* solver.js — 数织求解器：线推理（约束传播）+ 回溯，用于唯一解验证与随机关卡生成 */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  /**
   * 线推理：给定线索与部分确定线（-1 未知 / 0 空 / 1 填色），
   * 返回推理后确定值数组（仍 -1 表示无法确定）；无解返回 null
   */
  function lineSolve(line, clue) {
    const N = line.length, B = clue.length;
    // f(i,b)：从位置 i 起放置块 b..B-1 是否可行（记忆化，版本戳免重置）
    const memo = new Int8Array((N + 2) * (B + 2));
    const stamp = new Int32Array((N + 2) * (B + 2));
    let ver = 0;
    const idx = (i, b) => i * (B + 2) + b;

    function feasible(i, b) {
      if (b === B) {
        for (let k = i; k < N; k++) if (line[k] === 1) return false;
        return true;
      }
      if (i >= N) return false;
      const m = idx(i, b);
      if (stamp[m] === ver) return memo[m] === 1;
      let ok = false;
      // 该格留空
      if (line[i] !== 1 && feasible(i + 1, b)) ok = true;
      // 该格起放置第 b 块
      if (!ok) {
        const len = clue[b];
        if (i + len <= N) {
          let can = true;
          for (let k = i; k < i + len; k++) if (line[k] === 0) { can = false; break; }
          // 块后必须有空隙（贴行尾除外）
          if (can && i + len < N && line[i + len] === 1) can = false;
          if (can) ok = feasible(Math.min(i + len + 1, N), b + 1);
        }
      }
      stamp[m] = ver;
      memo[m] = ok ? 1 : 0;
      return ok;
    }

    ver++;
    if (!feasible(0, 0)) return null;

    const out = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const keep = line[i];
      ver++; line[i] = 0;
      const as0 = feasible(0, 0);
      ver++; line[i] = 1;
      const as1 = feasible(0, 0);
      line[i] = keep;
      if (as0 && as1) out[i] = -1;
      else if (as0) out[i] = 0;
      else if (as1) out[i] = 1;
      else return null; // 两值都不可行：矛盾
    }
    return out;
  }

  /** 从解构造 {rows, cols} 线索（复用 core） */
  function cluesFromBits(bits) {
    return NG.core.cluesFromSolution(NG.core.bitsToCells(bits), Math.sqrt(bits.length));
  }

  /** 构建行/列线定义 */
  function buildLines(clues, size) {
    const lines = [];
    for (let r = 0; r < size; r++) lines.push({ clue: clues.rows[r], isRow: true, index: r });
    for (let c = 0; c < size; c++) lines.push({ clue: clues.cols[c], isRow: false, index: c });
    return lines;
  }

  /** 约束传播至不动点；无矛盾返回 true（grid 中留下确定值与 -1） */
  function propagateGrid(grid, lines, size) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const L of lines) {
        const arr = new Array(size);
        for (let k = 0; k < size; k++) {
          arr[k] = L.isRow ? grid[L.index * size + k] : grid[k * size + L.index];
        }
        const res = lineSolve(arr, L.clue);
        if (!res) return false;
        for (let k = 0; k < size; k++) {
          if (res[k] === -1) continue;
          const gi = L.isRow ? L.index * size + k : k * size + L.index;
          if (grid[gi] === -1) { grid[gi] = res[k]; changed = true; }
          else if (grid[gi] !== res[k]) return false;
        }
      }
    }
    return true;
  }

  /**
   * 线可解判定：仅约束传播即填满全盘 = 谜题逻辑可解（唯一解的充分条件）
   * 成本远低于完整回溯搜索，用于随机生成过滤
   */
  function lineSolvable(clues, size) {
    const grid = new Int8Array(size * size).fill(-1);
    if (!propagateGrid(grid, buildLines(clues, size), size)) return false;
    for (let i = 0; i < grid.length; i++) if (grid[i] === -1) return false;
    return true;
  }

  /**
   * 解计数（上限剪枝）：约束传播 + 回溯
   * @param {number} budget 搜索节点预算（默认无限）。25×25 碎线图完整回溯可能指数爆炸，
   *   生产管线务必传预算；超预算返回 -1（解数未知，调用方保守处理）
   * @returns {number} 0 无解 / 1 唯一解 / >=2 多解 / -1 超预算未知
   */
  function countSolutions(clues, size, limit = 2, budget = Infinity) {
    const grid = new Int8Array(size * size).fill(-1);
    const lines = buildLines(clues, size);

    function search(countRef) {
      countRef.nodes++;
      if (countRef.nodes > countRef.budget) return;
      if (!propagateGrid(grid, lines, size)) return;
      let pivot = -1;
      for (let i = 0; i < grid.length; i++) if (grid[i] === -1) { pivot = i; break; }
      if (pivot === -1) { countRef.n++; return; }
      for (const v of [0, 1]) {
        if (countRef.n >= limit) return;
        const saved = Int8Array.from(grid);
        grid[pivot] = v;
        search(countRef);
        grid.set(saved);
      }
    }

    const ref = { n: 0, nodes: 0, budget };
    search(ref);
    return ref.nodes > budget ? -1 : ref.n;
  }

  /** 唯一解验证：位串 → 是否恰有一解 */
  function hasUniqueSolution(bits, size) {
    return countSolutions(cluesFromBits(bits), size, 2) === 1;
  }

  /** 4-邻域平滑：孤点消除 + 密集补全，让随机图案有块状感而非噪点 */
  function smoothGrid(g, size) {
    const out = g.slice();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const i = r * size + c;
        let n = 0;
        if (r > 0 && g[i - size] === 1) n++;
        if (r < size - 1 && g[i + size] === 1) n++;
        if (c > 0 && g[i - 1] === 1) n++;
        if (c < size - 1 && g[i + 1] === 1) n++;
        if (g[i] === 0 && n >= 3) out[i] = 1;
        else if (g[i] === 1 && n <= 1) out[i] = 0;
      }
    }
    return out;
  }

  /** 单次生成尝试：随机图案 → 密度检查 → 线可解验证；失败返回 null */
  function generateTry(size, rng, symP) {
    const half = Math.ceil(size / 2);
    const p = 0.44 + rng() * 0.14;
    let bits;
    if (rng() < symP) {
      // 四象限对称
      bits = new Array(size * size).fill(0);
      for (let r = 0; r < half; r++) {
        for (let c = 0; c < half; c++) {
          const v = rng() < p ? 1 : 0;
          bits[r * size + c] = v;
          bits[r * size + (size - 1 - c)] = v;
          bits[(size - 1 - r) * size + c] = v;
          bits[(size - 1 - r) * size + (size - 1 - c)] = v;
        }
      }
    } else {
      // 自由图案 + 平滑
      const g = new Array(size * size);
      for (let i = 0; i < size * size; i++) g[i] = rng() < p ? 1 : 0;
      bits = smoothGrid(g, size);
    }
    const filled = bits.reduce((a, b) => a + b, 0);
    const density = filled / (size * size);
    if (density < 0.38 || density > 0.62) return null;
    if (!lineSolvable(cluesFromBits(bits.join('')), size)) return null;
    return bits.join('');
  }

  /**
   * 随机生成线可解谜题（同步；异步分片见 levels.generateAsync）
   * @param {number} size 尺寸
   * @param {()=>number} rng [0,1) 随机源
   * @param {number} symP 对称图案概率（默认 0.1）
   * @param {number} maxTries 尝试上限
   * @returns {string|null} 解位串；失败返回 null
   */
  function generate(size, rng = Math.random, symP = 0.1, maxTries = 300) {
    for (let t = 0; t < maxTries; t++) {
      const bits = generateTry(size, rng, symP);
      if (bits) return bits;
    }
    return null;
  }

  NG.solver = { lineSolve, countSolutions, hasUniqueSolution, cluesFromBits, generate, generateTry, lineSolvable };
})();
