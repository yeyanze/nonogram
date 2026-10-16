/* levels.js — 关卡加载（内置 packs.js + 图标包按需 JSON）与随机生成 */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});

  const iconPacks = {};          // size → pack（按需加载后的内存缓存）
  const stickerPacks = {};       // size → pack（表情包关卡，独立页面；计入统计与署名，主页列表不显示）
  const STICKER_SIZES = [25];    // 表情包仅 25×25（15/20 与原作差距过大）
  const SIZES = [5, 10, 15, 20, 25];

  function allPacks() {
    const out = [];
    for (const src of [NG.PACKS]) {
      if (src && src.packs) out.push(...src.packs);
    }
    for (const s of SIZES) if (iconPacks[s]) out.push(iconPacks[s]);
    return out;
  }

  /** 按需加载某尺寸的图标关卡包（幂等）。
   *  优先读 <script> 预载的 NG.ICONS_JSON（file:// 直开可用）；
   *  未预载时回退 fetch（部署后可按需加载）。 */
  function ensureIcons(size) {
    if (iconPacks[size]) return Promise.resolve(iconPacks[size]);
    const pre = NG.ICONS_JSON && NG.ICONS_JSON[size];
    if (pre) {
      const pack = { size, levels: pre.levels || [] };
      iconPacks[size] = pack;
      return Promise.resolve(pack);
    }
    return fetch('data/icons-' + size + '.json')
      .then((r) => (r.ok ? r.json() : { levels: [] }))
      .then((data) => {
        const pack = { size, levels: data.levels || [] };
        iconPacks[size] = pack;
        return pack;
      })
      .catch(() => ({ size, levels: [] }));
  }

  /** 表情包关卡（NG.STICKERS_JSON 预载或 fetch data/stickers-25.json）。
   *  ensureStickers 调用后才会进 allLevels（统计/署名），启动时预载一次。 */
  function ensureStickers(size) {
    if (stickerPacks[size]) return Promise.resolve(stickerPacks[size]);
    const pre = NG.STICKERS_JSON && NG.STICKERS_JSON[size];
    const load = pre ? Promise.resolve(pre)
      : fetch('data/stickers-' + size + '.json')
        .then((r) => (r.ok ? r.json() : { levels: [] }))
        .catch(() => ({ levels: [] }));
    return load.then((data) => {
      const pack = {
        size,
        levels: (data.levels || []).map((lv) => Object.assign({ size, difficulty: NG.core.difficultyOf(size) }, lv)),
      };
      stickerPacks[size] = pack;
      return pack;
    });
  }

  function stickerBySize(size) {
    const pack = stickerPacks[size];
    return pack ? pack.levels : [];
  }

  function allLevels() {
    const out = [];
    const packs = allPacks().concat(STICKER_SIZES.map((s) => stickerPacks[s]).filter(Boolean));
    for (const pack of packs) {
      for (const lv of pack.levels) {
        out.push(Object.assign({ size: pack.size }, lv, {
          difficulty: lv.difficulty || NG.core.difficultyOf(pack.size),
        }));
      }
    }
    return out;
  }

  function sizes() {
    // 固定 5 档：未加载的图标包按需 fetch，tab 始终可见
    return SIZES.slice();
  }

  /** 主页列表：仅图标关与手绘关（表情包只在独立页面展示，不计入主页各规格列表） */
  function bySize(size) {
    return allPacks().flatMap((pack) => (pack.size === size ? pack.levels : []));
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
