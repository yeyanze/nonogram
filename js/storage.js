/* storage.js — localStorage 存档：进度、设置、续玩（节流写入）
 * version=2：关卡库全量重建（2026-10），version≠2 的本地存档启动即重置（旧关卡 id 全部失效） */
(function () {
  'use strict';
  const NG = (window.NG = window.NG || {});
  const KEY = 'nonogram.v1';
  const VERSION = 2;

  let data = load();
  let saveTimer = 0;

  function fresh() {
    return { version: VERSION, last: null, levels: {}, settings: { vibrate: true } };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.version !== VERSION) return fresh(); // 旧关卡库存档：彻底清除
        return {
          version: VERSION,
          last: d.last || null,
          levels: d.levels || {},
          settings: Object.assign({ vibrate: true }, d.settings),
        };
      }
    } catch (e) { /* 损坏则重置 */ }
    return fresh();
  }

  function save(immediate) {
    if (immediate) { write(); return; }
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = 0; write(); }, 500);
  }

  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 忽略配额错误 */ }
  }

  window.addEventListener('beforeunload', () => { if (saveTimer) { clearTimeout(saveTimer); write(); } });

  NG.storage = {
    get data() { return data; },
    save,
    saveLevelState(id, rec) {
      const cur = data.levels[id] || {};
      data.levels[id] = Object.assign(cur, rec);
      data.last = id;
      data.updatedAt = Date.now();
      save();
    },
    markDone(id, time) {
      if (id.indexOf('random-') === 0) {
        // 随机关不入关卡档案，仅累计胜场
        data.settings.randomWins = (data.settings.randomWins || 0) + 1;
        data.updatedAt = Date.now();
        save(true);
        return;
      }
      const cur = data.levels[id] || {};
      const rec = Object.assign(cur, { state: null, done: true, time });
      rec.bestTime = cur.bestTime ? Math.min(cur.bestTime, time) : time;
      data.levels[id] = rec;
      data.updatedAt = Date.now();
      save(true);
    },
    levelState(id) { return data.levels[id] || null; },
    setSetting(k, v) { data.settings[k] = v; data.updatedAt = Date.now(); save(); },
    clearLevel(id) { delete data.levels[id]; save(true); },
    /**
     * 导入并合并存档（导出格式：{app:'nonogram-save', version:2, exportedAt, data}）
     * 仅接受 version=2（与当前关卡库同代）；旧版存档因关卡 id 全部失效而拒绝。
     * 合并策略：完成状态取并集、最快纪录取 min、进行中存档保留步数多的一份、
     * 随机胜场取 max、其余设置与"继续上局"以更新时间较新的一方为准
     */
    importData(payload) {
      if (!payload || payload.app !== 'nonogram-save' || !payload.data || typeof payload.data !== 'object') {
        throw new Error('不是数织的存档文件');
      }
      if (payload.data.version !== VERSION) {
        throw new Error('存档来自旧版关卡库，关卡已全部更新，无法合并进度');
      }
      const inc = payload.data;
      const their = inc.levels || {};
      let imported = 0, newDone = 0;
      const filled = (s) => (s ? s.split('').filter((c) => c !== '0').length : -1);
      for (const id of Object.keys(their)) {
        const b = their[id];
        if (!b || typeof b !== 'object') continue;
        imported++;
        const a = data.levels[id];
        if (!a) {
          data.levels[id] = b;
          if (b.done) newDone++;
          continue;
        }
        const m = Object.assign({}, a);
        const wasDone = !!a.done;
        m.done = !!(a.done || b.done);
        if (b.bestTime && (!m.bestTime || b.bestTime < m.bestTime)) m.bestTime = b.bestTime;
        if (m.done) {
          if (!wasDone) newDone++;
          if (b.time && (!m.time || b.time < m.time)) m.time = b.time;
          m.state = null;
        } else if (b.state && filled(b.state) > filled(m.state)) {
          m.state = b.state;
          if (b.time) m.time = b.time;
        }
        data.levels[id] = m;
      }
      const mineT = data.updatedAt || 0;
      const theirT = payload.exportedAt || 0;
      const rw = Math.max(data.settings.randomWins || 0, (inc.settings && inc.settings.randomWins) || 0);
      if (theirT > mineT) {
        data.settings = Object.assign({}, inc.settings, { randomWins: rw });
        if (inc.last) data.last = inc.last;
      } else {
        data.settings.randomWins = rw;
      }
      data.updatedAt = Math.max(mineT, theirT);
      save(true);
      return { imported, newDone };
    },
  };
})();
