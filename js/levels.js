/* levels.js — 关卡加载（内置 packs.js + 图标/表情包按需加载）与随机生成
   关卡包优先读 <script> 预载的 NG.ICONS_JSON / NG.STICKERS_JSON（file:// 直开可用），
   未预载时动态注入 jsonp 脚本（SW 已预缓存，离线可用），最后回退 fetch json */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  const iconPacks = {};          // size → pack（按需加载后的内存缓存）
  const stickerPacks = {};       // size → pack（表情包关卡，独立页面；计入统计与署名，主页列表不显示）
  const STICKER_SIZES = [25];    // 表情包仅 25×25（15/20 与原作差距过大）
  const SIZES = [5, 10, 15, 20, 25];
  const pendingPacks = {};       // 加载去重：'i10' / 's25' → Promise
  let flatCache = null;          // allLevels() 扁平缓存
  const bySizeCache = {};        // size → 扁平缓存

  function invalidateCaches() {
    flatCache = null;
    for (const k of Object.keys(bySizeCache)) delete bySizeCache[k];
  }

  /** 动态注入脚本（jsonp 数据包；经典脚本 file:// 下同样可用） */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('加载失败: ' + src));
      document.head.appendChild(s);
    });
  }

  /** 难度评级：同尺寸内按求解特征分位数分 1~5 星（已有人工 difficulty 的关卡跳过） */
  function ratePack(levels, size) {
    const scored = [];
    for (const lv of levels) {
      if (lv.difficulty == null) scored.push({ lv, s: NG.core.solutionScore(lv.solution, size) });
    }
    if (!scored.length) return;
    const sorted = scored.map((x) => x.s).sort((a, b) => a - b);
    const step = sorted.length / 5;
    for (const { lv, s } of scored) {
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < s) lo = mid + 1; else hi = mid; }
      lv.difficulty = 1 + Math.min(4, Math.floor(lo / Math.max(step, 1)));
    }
  }

  async function ensureIcons(size) {
    if (iconPacks[size]) return iconPacks[size];
    const key = 'i' + size;
    if (!pendingPacks[key]) {
      pendingPacks[key] = (async () => {
        if (!(NG.ICONS_JSON && NG.ICONS_JSON[size])) {
          try { await loadScript('data/icons-' + size + '.jsonp.js'); } catch (e) { /* 未生成或缺失 */ }
        }
        let levels = (NG.ICONS_JSON && NG.ICONS_JSON[size] && NG.ICONS_JSON[size].levels) || null;
        if (!levels) {
          try {
            const r = await fetch('data/icons-' + size + '.json');
            if (r.ok) levels = (await r.json()).levels || [];
          } catch (e) { /* 忽略 */ }
        }
        const pack = { size, levels: levels || [] };
        ratePack(pack.levels, size);
        iconPacks[size] = pack;
        invalidateCaches();
        return pack;
      })();
    }
    return pendingPacks[key];
  }

  async function ensureStickers(size) {
    if (stickerPacks[size]) return stickerPacks[size];
    const key = 's' + size;
    if (!pendingPacks[key]) {
      pendingPacks[key] = (async () => {
        if (!(NG.STICKERS_JSON && NG.STICKERS_JSON[size])) {
          try { await loadScript('data/stickers-' + size + '.jsonp.js'); } catch (e) { /* 未生成或缺失 */ }
        }
        // 缩略图 base64 内嵌包（GitHub 上传文件数限制，192 张 webp 合并为 1 个 js）
        if (!NG.STICKER_THUMBS) {
          try { await loadScript('data/stickers-thumbs.js'); } catch (e) { /* 缺失则回退图片文件路径 */ }
        }
        let data = (NG.STICKERS_JSON && NG.STICKERS_JSON[size]) || null;
        if (!data) {
          try {
            const r = await fetch('data/stickers-' + size + '.json');
            if (r.ok) data = await r.json();
          } catch (e) { /* 忽略 */ }
        }
        const pack = {
          size,
          levels: ((data && data.levels) || []).map((lv) => Object.assign({ size, difficulty: null }, lv)),
        };
        ratePack(pack.levels, size);
        for (const lv of pack.levels) {
          if (lv.difficulty == null) lv.difficulty = NG.core.difficultyOf(size);
          const stem = (lv.img || '').split('/').pop().replace(/\.webp$/i, '');
          if (NG.STICKER_THUMBS && NG.STICKER_THUMBS[stem]) lv.img = NG.STICKER_THUMBS[stem];
        }
        stickerPacks[size] = pack;
        invalidateCaches();
        return pack;
      })();
    }
    return pendingPacks[key];
  }

  function allPacks() {
    const out = [];
    for (const src of [NG.PACKS]) {
      if (src && src.packs) out.push(...src.packs);
    }
    for (const s of SIZES) if (iconPacks[s]) out.push(iconPacks[s]);
    return out;
  }

  function stickerBySize(size) {
    const pack = stickerPacks[size];
    return pack ? pack.levels : [];
  }

  /** 全量关卡扁平列表（缓存；包加载后失效重建） */
  function allLevels() {
    if (flatCache) return flatCache;
    const out = [];
    const packs = allPacks().concat(STICKER_SIZES.map((s) => stickerPacks[s]).filter(Boolean));
    for (const pack of packs) {
      for (const lv of pack.levels) {
        out.push(Object.assign({ size: pack.size }, lv, {
          difficulty: lv.difficulty || NG.core.difficultyOf(pack.size),
        }));
      }
    }
    flatCache = out;
    return out;
  }

  function sizes() {
    // 固定 5 档：未加载的图标包按需加载，tab 始终可见
    return SIZES.slice();
  }

  /** 主页列表：仅图标关与手绘关（表情包只在独立页面展示，不计入主页各规格列表）。
   *  注入 size/difficulty（与 allLevels 一致），结果缓存 */
  function bySize(size) {
    if (bySizeCache[size]) return bySizeCache[size];
    const out = [];
    for (const pack of allPacks()) {
      if (pack.size !== size) continue;
      for (const lv of pack.levels) {
        out.push(Object.assign({ size: pack.size }, lv, {
          difficulty: lv.difficulty || NG.core.difficultyOf(pack.size),
        }));
      }
    }
    bySizeCache[size] = out;
    return out;
  }

  function find(id) {
    return allLevels().find((lv) => lv.id === id) || null;
  }

  /** 随机生成（同步，重试由 solver.generate 内部处理） */
  function generate(size) {
    const bits = NG.solver.generate(size, Math.random);
    if (!bits) return null;
    return buildLevel(bits, size);
  }

  function buildLevel(bits, size) {
    return {
      id: 'random-' + size + '-' + Date.now().toString(36),
      name: '随机图案',
      size,
      solution: bits,
      source: '程序生成',
      author: '',
      license: '',
      difficulty: NG.core.difficultyOf(size),
      random: true,
    };
  }

  /**
   * 异步随机生成：分片让出主线程，UI 不冻结
   * @returns {Promise<object|null>} 关卡对象
   */
  async function generateAsync(size, onTick) {
    const deadline = Date.now() + 15000;
    for (let i = 0; i < 600; i++) {
      const bits = NG.solver.generateTry(size, Math.random, 0.1);
      if (bits) return buildLevel(bits, size);
      if (i % 8 === 7) {
        if (onTick) onTick(i);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (Date.now() > deadline) break;
    }
    return null;
  }

  NG.levels = { allLevels, sizes, bySize, find, generate, generateAsync, ensureIcons, ensureStickers, stickerBySize, stickerSizes: STICKER_SIZES.slice() };
})();
