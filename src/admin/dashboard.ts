/**
 * 内嵌管理面板（单文件、零 CDN、离线可用）。
 *
 * 它不是"看板"而是"面板"：除了读，还能**写**——
 *   上游摘除/恢复 · 客户 key 创建/改层/禁用/轮换/重置额度 · 降损层开关热切换。
 *
 * 设计语言（六个视图 + 登录门 + 右侧抽屉）：
 *   · 登录门在未鉴权时拦住整个界面，令牌只存 localStorage，401 自动登出
 *   · 顶部页签导航 + 居中内容区，卡片栅格
 *   · 详情用右侧抽屉而不是常驻分栏——列表是主视图，详情是按需的
 *   · 「信任」是独立一页：把设计红线连同它的自动化测试摆在明面上，而不是埋在文档里
 *
 * 两个刻意的行为：
 * 1. 每次写操作都进"事件流"（服务端 relay_event 表），可审计、可回溯。
 * 2. 明文 key 只在创建/轮换那一刻显示一次，界面用醒目样式强调这一点——
 *    因为服务端只有 sha256，忘了就只能轮换。
 */

import { createHash } from 'node:crypto';
import { DASHBOARD_APP_MIN, DASHBOARD_APP_SHA } from './dashboard-app-min.js';

/* ============ 应用代码与 minify 机制（manual#394·签字层授权④）================
 * APP_SRC 是admin 应用代码的唯一真源（可读可 grep 可维护——从 HTML 模板里原样搬出，
 * 搬移前后为同一模板字面量、转义规则一致，渲染字节不变）。
 * appJs() 每次取用时做新鲜度校验：src/admin/dashboard-app-min.ts 里记录着生成时的
 * sha256——相等且 min 非空即用 min（gzip 86.7→~56KB，-35%）；不等（源码改过没重新
 * 生成）自动回落 APP_SRC——**永不服务过期页面**。改过 APP_SRC 后跑一次：
 *   node src/admin/gen-app-min.mjs && npm run build
 * 矩阵探针守着两件事：min 的新鲜度（哈希相等）与 min 确在服务（注释标记只存在于源码）。
 * ============================================================================ */
export const APP_SRC = `(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const formatNumber = (n, d) => (n == null ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d == null ? 0 : d }));
  const pct = (x) => (x == null ? '-' : (x * 100).toFixed(2) + '%');
  // 错误率色标（manual#139 抽自 4 处重复：ov 磁贴/按上游表/按模型表/上游页窗口列）——
  // >20% err / >5% warn / 其余 ok。全站一个口径，改阈值只改这一行。
  const rateCls = (r) => (r > .2 ? 'err' : r > .05 ? 'warn' : 'ok');
  const ms = (n) => (n == null || n === 0 ? '-' : n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n) + 'ms');
  const bytes = (n) => (n == null ? '-' : n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB');
  const TS = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  // 行内紧凑时间：当天显时刻，跨天显「MM-DD HH:MM」（manual#171）——账本 100 条常跨 ~35h
  // （实测 79/100 条属于前几天），只显时刻分不清是哪天；与 #169 轴标签同族（时序粒度）。
  const dayTime = (ts) => {
    const d = new Date(ts), n = new Date();
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? d.toLocaleTimeString('zh-CN')
      : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  /* ---------------- 登录门 ---------------- */
  let TOK = localStorage.getItem('relay_admin_token') || '';
  const showLogin = (msg) => { $('login').classList.add('on'); $('lerr').textContent = msg || ''; try { $('tok').focus(); } catch { /* 元素未就绪时忽略 */ } };
  const hideLogin = () => $('login').classList.remove('on');
  $('dologin').addEventListener('click', doLogin);
  // 回车提交+自动聚焦（manual#208）：登录框此前只认按钮点击——密码框按回车无反应
  // （KB 搜索/账本搜索早有 Enter 习惯，登录是最后漏的一个）；401 重登时自动聚焦，
  // 运营直接打字不用先点输入框。
  // 回车提交（manual#208）：密码框按回车无反应是最后漏的 Enter 习惯（KB 搜索/账本
  // 搜索早有）。聚焦已并入 showLogin 本体（不重赋值——外层模板字面量里的 const
  // 重赋值是运行时 TypeError 且 tsc 查不到，#208 当轮抓到并修正）。
  $('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
  $('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logout').addEventListener('click', () => { localStorage.removeItem('relay_admin_token'); TOK = ''; location.reload(); });

  async function doLogin() {
    TOK = $('tok').value.trim();
    try {
      // panel-info 免鉴权：体验模式（未配置 adminToken）本机可直连；生产必须有令牌
      const info = await raw('panel-info');
      if (info.tokenRequired) {
        if (!TOK) { showLogin('该网关需要管理令牌'); return; }
        // 立刻验一次，别等 boot 里的第一个数据请求才报错（那样像是面板坏了）
        await raw('overview?window=5m');
      }
      localStorage.setItem('relay_admin_token', TOK);
      hideLogin();
      boot();
    } catch (e) {
      showLogin(e.status === 401 ? '令牌无效' : ('无法连接管理接口：' + e.message));
    }
  }

  async function raw(path, opts) {
    // 超时硬化（manual#235）：此前 fetch 无超时——服务端卡住（重报告生成/DB 锁/进程挂起）
    // 时前端永远转圈：soft 降级（#191）只管失败不管挂起，运营看到的是无限 loading。
    // 30s 超时后抛出明确错误，由各调用点的 catch（soft/writeErr/toast）接管——
    // 注意 agent 触发是快路径（LLM 一轮 10-20s 在服务端），GUI 侧 30s 足够宽。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    let res;
    try {
      res = await fetch('/admin/api/' + path, {
        ...(opts || {}),
        signal: ac.signal,
        headers: { ...(TOK ? { 'X-Admin-Token': TOK } : {}), ...(opts && opts.body ? { 'content-type': 'application/json' } : {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw Object.assign(new Error('请求超时（30s）——服务端可能正忙，稍后重试'), { status: 0, timeout: true });
      throw e;
    }
    clearTimeout(timer);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      // 401 全局 funnel（manual#119）：会话过期（管理令牌被轮换/网关带新令牌重启）时，
      // 此前只有 render 路径会跳登录页，操作类 handler（保存表单/旋转 key/删 KB）各自 toast
      // 一句「未授权」——运营看到莫名其妙的操作失败，不知道要去重新登录。现在任何 401 都
      // 清 token + 弹登录页；render 的 catch 仍会后到并把文案 refine 成具体原因。
      if (res.status === 401) {
        localStorage.removeItem('relay_admin_token');
        TOK = '';
        showLogin('登录已过期，请重新输入管理令牌');
      }
      // type/code 摊平到错误对象（manual#195）：后端 #194 统一了 {message,type,code} 三件套，
      // 此处原只抛 {status, body}——分类器要用 code 得钻 body.error.code 两层。摊平后
      // writeErr 等分类器可直接按 e.code 精判（kb_exists/agent_running 各有定制指引）。
      throw Object.assign(new Error(body?.error?.message || ('HTTP ' + res.status)), {
        status: res.status, type: body?.error?.type, code: body?.error?.code, body,
      });
    }
    return body;
  }
  const api = (p, o) => raw(p, o);

  function toast(msg, kind) {
    const d = document.createElement('div');
    if (kind) d.className = kind;
    d.innerHTML = msg;
    $('toast').appendChild(d);
    setTimeout(() => d.remove(), kind === 'r' ? 9000 : 4200);
  }

  /* ---------------- 抽屉 ---------------- */
  function drawer(title, html, foot) {
    $('dt').textContent = title;
    $('dbody').innerHTML = html;
    // 默认 footer 的关闭按钮用绑定式而非内联 onclick（manual#141）——内联写法要靠
    // \\' 转义引号穿过外层 HTML 模板，正是 #84~#92 咬过人的转义类；绑定式与全文件其余
    // 交互一致，且 closeDrawer 就在作用域内。
    $('dfoot').innerHTML = foot || '<button class="bare" id="dfoot-close">关闭</button>';
    const dfc = $('dfoot-close');
    if (dfc) dfc.addEventListener('click', closeDrawer);
    $('drawer').classList.add('on');
    $('scrim').classList.add('on');
  }
  const closeDrawer = () => { $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); };
  $('dclose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // P4 修复：键盘快捷键（GitHub 式）
  // r: 刷新当前页面
  // 1-9: 切换到对应页签
  // ?: 显示快捷键帮助
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // r: 刷新
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      render();
      return;
    }
    // 1-9: 切换页签
    const num = parseInt(e.key);
    if (num >= 1 && num <= 9 && TAB_IDS[num - 1]) {
      e.preventDefault();
      VIEW = TAB_IDS[num - 1];
      location.hash = VIEW;
      nav();
      closeDrawer();
      render();
      return;
    }
    // ?: 显示快捷键帮助
    if (e.key === '?') {
      e.preventDefault();
      toast(t('shortcutHint'), 'info');
      return;
    }
  });
  // "/" 聚焦账本搜索（manual#115）：GitHub 式快捷键。排障流程的第一动作永远是搜索——客户报障→
  // 搜 request-id→回车开 trace（#84/#92 的 Enter 链）。输入/选择器聚焦时不劫持（/ 要能正常
  // 打进输入框）；只在账本页生效（不替用户做页面跳转，避免误导航）。
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (VIEW !== 'ledger') return;
    const q = $('l-q');
    if (q) { e.preventDefault(); q.focus(); q.select(); }
  });

  /* ---------------- 视图表 ---------------- */
  /*
   * i18n（v406）：语言切换此前只有按钮+localStorage，**没有任何实际效果**——一个点了没反应的
   * 控件比没有更糟（运营会以为界面坏了）。这里补上真正的字典层：界面骨架（页签/页头控件/
   * 登录门/常用动作）走 t()，正文与业务术语保持中文（翻译业务文案需要产品决策，不在本轮）。
   * 缺键回退中文（t 内 ?? I18N.zh[key]），所以漏翻译最多是不切换，不会显示裸 key。
   */
  const I18N = {
    zh: {
      tabs: { ov: '总览', met: '指标', users: '客户 Key', ch: '上游', kb: '知识库', agent: '运营 Agent', ledger: '请求账本', diag: '排障', ops: '运维', trust: '信任' },
      panel: '管理面板', win: '窗口', autoRefresh: '自动刷新', refreshEvery: '刷新间隔',
      refresh: '刷新', logout: '退出', login: '登录', retry: '重试',
      loadFailed: '加载失败', loading: '加载中...',
      loadFailedHint: '可能是网络或网关暂时不可达。修复后点重试，或换页签再回来。',
      w5m: '5 分钟', w1h: '1 小时', w24h: '24 小时', w7d: '7 天', w30d: '30 天',
      s5: '5 秒', s15: '15 秒', s30: '30 秒', s60: '60 秒',
      loginHint: '输入管理令牌登录（仅保存在本浏览器 localStorage）',
      themeTip: '切换主题（暗色/亮色）', langTip: '切换语言（中/EN）',
      shortcutHint: '快捷键: r=刷新, 1-9=切换页签, /=搜索, Esc=关闭',
    },
    en: {
      tabs: { ov: 'Overview', met: 'Metrics', users: 'Client Keys', ch: 'Upstreams', kb: 'Knowledge', agent: 'Agent Ops', ledger: 'Request Log', diag: 'Diagnose', ops: 'Ops', trust: 'Trust' },
      panel: 'Admin Panel', win: 'Window', autoRefresh: 'Auto refresh', refreshEvery: 'Interval',
      refresh: 'Refresh', logout: 'Sign out', login: 'Sign in', retry: 'Retry',
      loadFailed: 'Load failed', loading: 'Loading...',
      loadFailedHint: 'The network or gateway may be temporarily unreachable. Retry, or switch tabs and come back.',
      w5m: '5 min', w1h: '1 hour', w24h: '24 hours', w7d: '7 days', w30d: '30 days',
      s5: '5 sec', s15: '15 sec', s30: '30 sec', s60: '60 sec',
      loginHint: 'Enter the admin token (stored only in this browser localStorage)',
      themeTip: 'Toggle theme (dark/light)', langTip: 'Toggle language (zh/EN)',
      shortcutHint: 'Shortcuts: r=refresh, 1-9=switch tab, /=search, Esc=close',
    },
  };
  let LANG = 'zh';
  try { const s = localStorage.getItem('relay_admin_lang'); if (s === 'zh' || s === 'en') LANG = s; } catch { /* 隐私模式 */ }
  // 缺键回退中文：翻译不全时最坏是这一项不切换，不会渲染出裸 key 或 undefined
  const t = (key) => (I18N[LANG] && I18N[LANG][key] !== undefined ? I18N[LANG][key] : I18N.zh[key]);

  const TABS = [
    ['ov', '总览'], ['met', '指标'], ['users', '客户 Key'], ['ch', '上游'],
    ['kb', '知识库'], ['agent', '运营 Agent'], ['ledger', '请求账本'], ['diag', '排障'], ['ops', '运维'], ['trust', '信任'],
  ];
  // 页签进 URL hash：刷新/收藏/分享都停在同一个页面，也能被直接打开（便于截图与排查）
  const TAB_IDS = TABS.map(([id]) => id);
  const hashTab = () => (TAB_IDS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'ov');
  let VIEW = hashTab();

  function nav() {
    // 页签标题随页面走（manual#120）：多标签开着（或从书签 #ledger 直达）时分不清哪个 tab 是
    // 哪页——浏览器 tab 上只有静态的站点名。标题同步成「页面名 · api-relay」。
    const cur = TABS.find(([id]) => id === VIEW);
    document.title = (cur ? t('tabs')[cur[0]] + ' · ' : '') + 'api-relay ' + t('panel');
    $('nav').innerHTML = TABS.map(([id]) => '<button data-t="' + id + '"' + (VIEW === id ? ' class="on"' : '') + '>' + t('tabs')[id] + '</button>').join('');
    // 切页先关抽屉（manual#113）：抽屉开着切页签会有三件事同时坏——①抽屉浮层盖在新页上；
    // ②抽屉里的绑定（编辑表单/对比输入）仍指着旧页数据，在陈旧浮层里操作=操作旧状态；
    // ③自动刷新的暂停守卫查的是 drawer 状态——忘关抽屉会让新页面静默停止刷新。
    $('nav').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { VIEW = b.dataset.t; location.hash = VIEW; nav(); closeDrawer(); render(); }));
  }

  /*
   * 页头控件文案应用（v406）：静态 HTML 里带 i18n 数据属性的节点（data-i18n 取文本、
   * data-i18n-title 取 title、data-i18n-opt 按逗号键序刷 option）在这里统一刷成当前语言。
   * 用数据属性而非 innerHTML 重建：select 的当前选中值不会被重置（重建会丢选中态）。
   * 注：本注释刻意不写完整的属性示例，避免属性扫描脚本把示例当成真实引用。
   */
  function applyChrome() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { const k = el.dataset.i18n; const v = t(k); if (typeof v === 'string') el.textContent = v; });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { const v = t(el.dataset.i18nTitle); if (typeof v === 'string') el.title = v; });
    document.querySelectorAll('[data-i18n-opt]').forEach((sel) => {
      const keys = sel.dataset.i18nOpt.split(',');
      Array.prototype.forEach.call(sel.options, (op, i) => { const v = t(keys[i]); if (typeof v === 'string') op.textContent = v; });
    });
    const lt = $('langToggle');
    if (lt) { lt.textContent = LANG === 'zh' ? '🌐' : '中'; lt.title = t('langTip'); }
    const tt = $('themeToggle');
    if (tt) tt.title = t('themeTip');
  }

  window.addEventListener('hashchange', () => { const t = hashTab(); if (t !== VIEW) { VIEW = t; nav(); closeDrawer(); render(); } });

  // 数据新鲜度指示（manual#112）：自动刷新每 15s 但头部只有时钟（当前时间）——fetch 静默失败时
  // 旧数据留在屏幕上，运营分不清新旧。每次成功渲染打时间戳；>60s 没更新变红=数据可能陈旧
  // （自动刷新失败/被关闭/抽屉开着时暂停刷新都会让它自然变旧，属预期信号不是错误）。
  let lastFresh = 0;
  const markFresh = () => { lastFresh = Date.now(); const f = $('fresh'); if (f) { f.textContent = '数据 ' + new Date().toLocaleTimeString('zh-CN'); f.style.color = ''; } };

  async function render() {
    // P4 修复：改进加载状态（添加 loading 提示）
    const main = $('main');
    main.classList.add('loading');
    // 添加 loading 提示（如果还没有）
    if (!$('loading-tip')) {
      const tip = document.createElement('div');
      tip.id = 'loading-tip';
      tip.className = 'loading-tip';
      tip.textContent = t('loading');
      main.appendChild(tip);
    }
    try {
      if (VIEW === 'ov') await vOv();
      else if (VIEW === 'met') await vMet();
      else if (VIEW === 'users') await vKeys();
      else if (VIEW === 'ch') await vCh();
      else if (VIEW === 'kb') await vKb();
      else if (VIEW === 'agent') await vAgent();
      else if (VIEW === 'ledger') await vLedger();
      else if (VIEW === 'diag') await vDiag();
      else if (VIEW === 'ops') await vOps();
      else if (VIEW === 'trust') await vTrust();
      markFresh();
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem('relay_admin_token'); showLogin('令牌已失效，请重新登录'); return; }
      // 整页错误态（manual#325）：此前失败只弹 toast——首屏加载失败时主区留空，运营看到
      // 空白页+一闪而过的 toast，因果连不上。#151 的按块降级覆盖多块页（排障/运维/上游）；
      // 单块页（metrics/ov/users 等）整页失败时给可见错误块+重试按钮。刷新失败（有旧内容）
      // 时保留旧数据+toast——旧数据比错误态有用，不清空。
      if (!main.innerHTML.trim()) {
        main.innerHTML = '<section class="block"><h2>' + t('loadFailed') + '</h2>' +
          '<div class="note bad">' + esc(e.message) + '</div>' +
          '<p class="dim">' + t('loadFailedHint') + '</p>' +
          '<button class="pri" id="err-retry">' + t('retry') + '</button></section>';
        const rb = $('err-retry');
        if (rb) rb.addEventListener('click', () => render());
      }
      toast('加载失败：' + esc(e.message), 'r');
    } finally {
      main.classList.remove('loading');
      // 移除 loading 提示
      const tip = $('loading-tip');
      if (tip) tip.remove();
    }
  }

  const win = () => $('win').value;
  const bucket = () => ({ '5m': 60000, '1h': 300000, '24h': 3600000, '7d': 86400000, '30d': 86400000 }[win()] || 3600000);
  // 金额格式化：小额预算用 toFixed(2) 会显示成 ¥0.00，看起来像没设额度
  const cny = (v) => { const a = Math.abs(Number(v) || 0); const d = a >= 1 ? 2 : a >= 0.01 ? 4 : 6; return '¥' + (Number(v) || 0).toFixed(d); };
  // 长 label 截断显示（manual#289）：#151 给 key label 加了 ≤64 写入上限，但历史数据里
  // 有 5000 字的（上限前的测试残留）——keys 表格裸渲会把那一行撑爆、风险 chip 的 title
  // 变成巨型 tooltip。与 #281 同族：写入侧有上限，历史数据要展示侧防御。超长截断+title 全量。
  const shortLabel = (l, n) => {
    const s = String(l == null ? '' : l);
    return s.length > n ? '<span title="' + esc(s) + '">' + esc(s.slice(0, n)) + '…</span>' : esc(s);
  };
  const emptyBox = (icon, msg, hint) => '<div class="empty"><div class="ic">' + icon + '</div><div>' + msg + '</div>' + (hint ? '<div class="dim" style="font-size:12px">' + hint + '</div>' : '') + '</div>';
  const tile = (k, v, sub) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  // 写动作错误分类（manual#193，#192 模式推广）：400/404/409 是输入或状态问题（用户可修正——
  // 后端 code 已语义化：kb_exists/agent_running/invalid_*），黄色+修正指引；5xx/网络才是系统
  // 故障，红色。一律红显会把「改个 id 就好」显示成「系统坏了」。
  const writeErr = (action, e) => {
    const st = e && e.status;
    // code 精判（manual#195）：后端语义化 code 的定制指引优先于状态码粗分类。
    const CODE_HINT = {
      kb_exists: '该 id 的知识库已存在——换个 id，或去知识库页编辑原库',
      agent_running: '上一轮 Agent 仍在运行——LLM 一轮 10-20 秒，稍后再点',
      agent_disabled: 'Agent 未启用——在配置里开 agent.enabled 后重启',
      payload_too_large: '请求体超限——批量灌入单次上限 50 篇，请分批',
      // 以下两个（manual#197）：503 kb_unavailable 是配置/存储状态不是系统故障（红显会误导
      // 运营去查网络）；kb_error 是 addDoc 写入期失败（分块/落库），重试或看事件日志。
      kb_unavailable: '知识库未启用或存储故障——检查配置里的 kb.path 与 data/ 目录权限',
      kb_error: '写入期失败（分块或落库异常）——稍后重试；持续失败看「排障 → 事件日志」',
    };
    if (e && e.code && CODE_HINT[e.code]) {
      return { text: action + '未完成：' + esc(e.message) + '——' + CODE_HINT[e.code], tone: 'y' };
    }
    if (st === 409) return { text: action + '冲突：' + esc(e.message) + '（刷新状态后重试，或换个标识）', tone: 'y' };
    if (st === 400 || st === 404) return { text: action + '未完成（输入问题）：' + esc(e.message), tone: 'y' };
    return { text: action + '失败：' + esc(e.message), tone: 'r' };
  };
  const bar = (v, max, cls) => '<div class="hbar"><span class="nm">' + esc(v.nm) + '</span><span class="track"><i class="in ' + (cls || '') + '" style="width:' + (max > 0 ? Math.min(100, (v.val / max) * 100).toFixed(1) : 0) + '%"></i></span><span class="vl">' + esc(v.txt) + '</span></div>';

  // 复制调用命令（manual#83 引擎进化·GUI 体验层）：P3 失败归因的 quick_action 思路搬到管理面——
  // 运维看完可达性表的下一句永远是"那我现在怎么调"，直接给可执行命令，而不是让他去翻文档拼 curl。
  // clipboard API 在非安全上下文（http + 非 localhost）不可用 → execCommand 兜底；两者都败只提示不阻断（fail-open）。
  const copyText = async (text, okMsg) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      } catch { toast('复制失败，请手动选中复制', 'y'); return; }
    }
    toast(okMsg || '已复制到剪贴板', 'g');
  };
  const curlFor = (model) => 'curl -s ' + location.origin + '/v1/chat/completions -H "authorization: Bearer <你的key>" -H "content-type: application/json" -d ' + "'" + '{"model":"' + model + '","messages":[{"role":"user","content":"你好"}]}' + "'";


  /* ============ 一眼看懂：现在到底能不能用 ============ */
  function statusBanner(ov, s) {
    const provs = ov.providers || [];
    const enabled = provs.filter((p) => !p.disabled);
    const total = s.overall.requests;
    const errs = s.overall.errors;
    const reasons = s.byFailureReason || [];
    const top = reasons[0];
    // 主因释义（manual#132）：通用横幅此前只报原因代码（如 client_aborted），运营还得去想
    // 「这是什么、往哪查」——词表与归因目录（attribution/catalog）的 action 对齐，
    // 一句含义+方向，第一屏幕完成初步归因。覆盖本站真实画像里的常见主因。
  const REASON_HINT = {
      client_aborted: '客户端中断——客户端侧超时/断流，不是上游故障；优先排查客户端超时与网络（账本里看它断在哪一步）',
      upstream_unavailable: '上游不可用——连接失败或 5xx；看上游页的健康与熔断状态',
      rate_limited: '上游限流——配额/RPM 打满；稍等或降权（可自动重试恢复）',
      quota_exhausted: '上游配额耗尽——去厂商控制台充值，充完清熔断',
      auth_invalid: '上游鉴权失败——密钥无效/过期；去厂商控制台换 key（网关侧改没用）',
      model_not_found: '模型不存在——客户端请求了未声明的模型；配 fallback 或引导客户端（总览页按模型表有「未声明」标记）',
      upstream_timeout: '上游超时——可自动重试；持续超时看上游页的 ewma 延迟',
      network_error: '网络错误——网关到上游的网络问题；看上游页连续失败计数',
      invalid_request: '请求非法——客户端参数错误；引导客户端修请求',
      relay_internal_error: '网关内部错误——看排障页事件日志',
      // 补齐剩余 7 条（manual#219）：REASON_HINT 此前只覆盖常见主因（#132 的范围），
      // 归因目录 17 条里漏了这 7 个——它们成为主因时总览横幅只显裸代码。与目录逐条对齐。
      permission_denied: '上游鉴权通过但无权限——key 没有该模型的访问权；去厂商控制台开权限或换 key',
      model_overloaded: '上游模型过载——厂商容量不足；稍等或切同族备用模型（可自动重试恢复）',
      context_length_exceeded: '上下文超长——请求 token 超过模型上限；引导客户端截断历史或换长上下文模型',
      content_filtered: '内容被过滤——上游安全策略拦截；引导客户端调整 prompt 内容',
      tool_call_invalid: '工具调用非法——客户端 tool/function 定义或参数不合上游 schema；引导客户端修工具定义',
      stream_interrupted: '流式中断——SSE 连接中途断流；看账本断在哪一步，客户端侧重试或切非流式',
      unknown: '未归因失败——失败原因未能自动分类；看排障页事件日志与该条的原始 detail',
    };
    const authFail = reasons.find((r) => r.reason === 'auth_invalid');
    const quotaFail = reasons.find((r) => r.reason === 'quota_exhausted');
    const line = (kind, title, body, act) =>
      '<div class="note ' + kind + '" style="border-left-width:4px"><div style="font-size:14px;font-weight:700;color:var(--fg);margin-bottom:3px">' + title + '</div>' + body + (act ? '<div style="margin-top:7px">' + act + '</div>' : '') + '</div>';

    if (provs.length === 0) {
      return line('bad', '⚠ 还没有配置上游', '网关起来了，但没有任何上游可以转发。所有请求都会返回 503。',
        '跑 <span class="mono">node dist/cli.js starter --vendor &lt;厂商&gt;</span> 生成配置，再重启。');
    }
    if (enabled.length === 0) {
      return line('bad', '⚠ 所有上游都被摘除了', '当前 ' + provs.length + ' 个上游全部处于摘除/禁用状态，请求无处可去。',
        '到<a href="#ch">「上游」页</a>把需要的上游「恢复启用」。');
    }
    if (authFail && authFail.count > 0 && authFail.count >= errs * 0.5) {
      return line('bad', '⚠ 上游拒绝了你配置的密钥',
        '最近 ' + authFail.count + ' 次失败是 <b>上游鉴权失败</b>（密钥无效 / 过期 / 未开通权限），不是请求本身的问题。<br>' +
        '从网关这边改是没用的——要去厂商控制台检查这个 key。',
        '到<a href="#ledger">「请求账本」</a>点开任意一条失败，能看到上游返回的原始错误文案。');
    }
    if (quotaFail && quotaFail.count > 0 && quotaFail.count >= errs * 0.5) {
      return line('bad', '⚠ 上游账户余额/额度不足',
        '最近 ' + quotaFail.count + ' 次失败是 <b>上游配额耗尽</b>。请求本身没问题，是账户没钱了。',
        '去厂商控制台充值；充完到<a href="#ch">「上游」页</a>点一次「清熔断」即可恢复。');
    }
    // 客户端 key 被拒（网关 401）与"上游拒绝密钥"要分开说：一个换客户端 key，一个换上游密钥。
    // 这次评测"API 全天 401"的真实原因就是前者——必须一眼指出来，而不是含糊地说错误率高。
    const clientAuth = s.clientAuthFailures;
    if (clientAuth && clientAuth.count > 0 && clientAuth.count >= errs * 0.5) {
      return line('bad', '⚠ 客户端提交的 key 不对（' + formatNumber(clientAuth.count) + ' 次 401）',
        '网关拒绝了 <b>' + formatNumber(clientAuth.count) + '</b> 次请求：客户端提交的 key 不是本网关当前签发的（换过 key 后旧的作废了、或拿错了 key）。' +
        '<br>这不是上游故障，网关本身是好的。到<a href="#users">「客户 Key」页</a>粘贴你手上的 key 做自检，或对照已签发 key 的指纹。');
    }
    // 上游窗口错误率突告（manual#104）：byProvider 窗口数据自 #101 起总览页有展示，但横幅——运营第一眼——
    // 不告警；错题本头号问题（stepfun 46.7% 形态）应在横幅直接点名+给动作，而不是等运营翻到总览页中段。
    // 阈值：请求数≥10 且错误率≥40%（小样本不惊动；unknown 上游 13/13 也会被点名——它同样值得处理）。
    const hotProvs = (s.byProvider || []).filter((p) => (p.requests || 0) >= 10 && (p.errorRate || 0) >= .4);
    if (hotProvs.length) {
      const names = hotProvs.map((p) => '<b>' + esc(p.key) + '</b> ' + pct(p.errorRate) + '（' + p.requests + ' 次失败 ' + p.errors + '）').join('、');
      return line('warn', '⚠ ' + hotProvs.length + ' 个上游窗口错误率 ≥40%',
        names + '。单上游劣化会拉高整体错误率——先分清是配额限流（等一会/降权）还是真故障（摘除）。窗口：' + esc(ov.windowLabel || '') + '。',
        '到<a href="#ov">总览页「按上游」区块</a>看全量对比，或到<a href="#ch">「上游」页</a>摘除/清熔断。');
    }
    if (total >= 5 && errs / total >= 0.5) {
      return line('warn', '⚠ 错误率偏高（' + pct(errs / total) + '）',
        (top ? '主要失败原因：<b>' + esc(top.reason) + '</b>（' + top.count + ' 次）' +
          (REASON_HINT[top.reason] ? '——' + esc(REASON_HINT[top.reason]) : '') + '。<br>' : '') +
        '到<a href="#ledger">「请求账本」</a>按失败结果筛选，点开任意一条看它卡在哪一步。');
    }
    if (total === 0) {
      return line('', '还没有请求', '网关在正常运行。发一个请求就能看到数据：<br>' +
        '<span class="mono">curl -s ' + location.origin + '/v1/chat/completions -H &quot;authorization: Bearer sk-relay-pro&quot; -H &quot;content-type: application/json&quot; -d &quot;{\\'model\\':\\'&lt;模型名&gt;\\',\\'messages\\':[{\\'role\\':\\'user\\',\\'content\\':\\'你好\\'}]}&quot;</span>');
    }
    const openBreakers = provs.filter((p) => p.breakerOpen);
    if (openBreakers.length > 0) {
      return line('warn', '⚠ 有上游处于熔断状态（' + openBreakers.length + '/' + provs.length + '）',
        '熔断中的上游：<b>' + openBreakers.map((p) => esc(p.id)).join(', ') + '</b>。请求会自动走其他可用上游；只有一个上游时会一直失败。',
        '到<a href="#ch">「上游」页</a>确认故障是否已恢复，然后「清熔断」。');
    }
    // 运行正常也带主因构成（manual#132）：错误率没到横幅阈值但偏高时（如 19% 且 60% 是
    // client_aborted），光说「运行正常」会掩盖构成——补一句主因+释义，第一屏就知道
    // 失败是客户端侧还是网关侧。阈值 5%：低于它不值得占版面。
    const mild = (top && errs > 0 && s.overall.errorRate > 0.05)
      ? '<br>失败以 <b>' + esc(top.reason) + '</b> 为主（' + top.count + '/' + errs + ' 次）' +
        (REASON_HINT[top.reason] ? '——' + esc(REASON_HINT[top.reason]) : '') + '。'
      : '';
    return line('', '✓ 运行正常',
      '最近 ' + total + ' 个请求里失败 ' + errs + ' 次（' + pct(s.overall.errorRate) + '），' +
      enabled.length + ' 个上游可用' + (s.overall.totalTokens ? '，已消耗 ' + formatNumber(s.overall.totalTokens) + ' token' : '') + '。' + mild);
  }

  /* ============ 一键值班摘要（manual#154） ============ */
  // 交接班/群里通报用：把总览页散在九个区块里的关键读数聚成一段可复制纯文本。
  // 设计原则：①一屏能答完"健康吗/哪坏了/下一步"三问；②数字与页面同源（不另算口径）；
  // ③预警行只收录会触发横幅或 chip 的条件——摘要的职责是"需要人管的事"，不是复述页面。
  function buildShiftBrief(ov, s, agentState, bUp, kbCount, keys) {
    const NL = String.fromCharCode(10);
    const now = new Date();
    const hm = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
    const L = [];
    L.push('【api-relay 值班摘要】' + hm(now.getTime()) + ' · 窗口 ' + (ov.windowLabel || '-') + (SITE_VERSION ? ' · v' + SITE_VERSION : ''));
    const o = s.overall || {};
    L.push('一、总体：请求 ' + formatNumber(o.requests) + '，失败 ' + formatNumber(o.errors) + '（' + pct(o.errorRate || 0) + '），token ' + formatNumber(o.totalTokens) + '，成本 ¥' + Number(o.costCny || 0).toFixed(4) + '，p95 ' + ms(o.p95Ms));
    const provs = (s.byProvider || []).map((r) => r.key + ' ' + pct(r.errorRate || 0) + '（' + r.requests + ' 次）' + ((r.requests || 0) >= 10 && (r.errorRate || 0) >= .4 ? ' ⚠' : ''));
    L.push('二、上游：' + (provs.length ? provs.join('｜') : '窗口内无请求'));
    const reasons = (s.byFailureReason || []).slice(0, 4).map((r) => r.reason + ' ' + r.count);
    // 模型维度（manual#230）：与 #229 报告的模型节对齐——交接文本要知道哪个模型在跑/
    // 在错。slim overview 自带 byModel（#164 的 slim 只省略 keys/events/topErrors），零新请求。
    const mods = (s.byModel || []).slice(0, 5).map((m) => m.key + '×' + m.requests + (m.errors ? '（错' + m.errors + '）' : ''));
    L.push('三、模型：' + (mods.length ? mods.join('｜') + ((s.byModel || []).length > 5 ? '｜等 ' + (s.byModel || []).length + ' 个' : '') : '窗口内无请求'));
    L.push('四、失败主因：' + (reasons.length ? reasons.join('｜') : '无失败'));
    // 预警行：与 statusBanner 同口径的条件（热上游/全摘除/熔断），只列需要动作的
    const hot = (s.byProvider || []).filter((r) => (r.requests || 0) >= 10 && (r.errorRate || 0) >= .4);
    const openBrk = (ov.providers || []).filter((p) => p.breakerOpen);
    const warns = [];
    if (hot.length) warns.push(hot.map((r) => r.key + ' 窗口错误率 ' + pct(r.errorRate)).join('、') + '——先分清配额限流（等一会/降权）还是真故障（摘除）');
    if (openBrk.length) warns.push('熔断中：' + openBrk.map((p) => p.id).join('、') + '——确认恢复后清熔断');
    if (!(ov.providers || []).some((p) => !p.disabled)) warns.push('全部上游被摘除——请求无处可去');
    L.push('五、需要处理：' + (warns.length ? warns.join('；') : '无（窗口内无触发横幅/ chip 的条件）'));
    const lr = s.lossReduction || {};
    L.push('六、降损层：归因覆盖 ' + pct(lr.attributionCoverage || 0) + '｜自动恢复 ' + formatNumber(lr.autoRecovered) + '｜预检降级 ' + formatNumber(lr.precheckDegraded) + '｜重复检测 ' + formatNumber(lr.duplicateRetries));
    const lastRun = ((agentState && agentState.runs) || [])[0];
    L.push('七、Agent 最新' + (lastRun ? '（' + hm(lastRun.startedAt) + (lastRun.trigger === 'manual' ? ' 手动' : '') + '）：' + String((lastRun.decision && lastRun.decision.summary) || '').slice(0, 120) : '：尚无运行记录'));
    const plat = [];
    plat.push('B 站（8767）' + (bUp ? '运行中' : '未运行'));
    plat.push('KB ' + (kbCount == null ? '-' : kbCount + ' 篇'));
    plat.push('Agent ' + ((agentState && agentState.status && agentState.status.enabled) ? Math.round((agentState.status.intervalMs || 0) / 60000) + ' 分钟巡检在网' : '未启用'));
    L.push('八、平台状态：' + plat.join('｜'));
    // Key 预警行（manual#162）：交接 artifact 必须包含『需关注』的 key——#160 的筛选首跑
    // 就抓出预算耗尽的 key（启用中但请求全 402），这类事只写在面板里会漏给接班人。
    // 判定复用 keyState（与 keys 页 chip/筛选同一处阈值）。keys 取数失败（null）时
    // 不再静默跳过该行（manual#375）：摘要是要转发给接班人的 artifact——静默少一行，
    // 接手方不会察觉『没看到』和『没有』的区别（#374 同族：失败不得伪装成空/缺失）。
    // 改为显式占行说明省略原因。
    if (keys) {
      const risky = (keys || []).filter((k) => keyState(k).attention);
      const desc = risky.map((k) => {
        const st = keyState(k);
        const why = st.usedUp ? '额度/预算耗尽' : st.expired ? '已过期' : st.expiringSoon ? st.expDays + ' 天后过期' : '将耗尽(≥85%)';
        return k.id + '(' + shortLabel(k.label, 30) + '·' + why + ')';
      });
      L.push('九、Key 预警：' + (risky.length ? risky.length + ' 个需关注——' + desc.join('；') : '无（无临期/将耗尽/已过期/已用完的启用 key）'));
    } else {
      L.push('九、Key 预警：（key 列表取数失败，本行省略——请到面板确认，勿据此判断无风险 key）');
    }
    return L.join(NL);
  }

  /* ============ 总览 ============ */
  async function vOv() {
    const capSafe = (p) => api(p).catch((e) => (e && (e.status === 404 || e.status === 503) ? { enabled: false } : Promise.reject(e)));
    // overview 切 slim（manual#164）：本页 15s 自动刷新只用 summary/providers/overheadUs/
    // store——keys（25.8KB）/events/topErrors 是死重（各自的专用端点另取）。46KB→4KB。
    // keys 按 60s 缓存并行取（manual#221）：供需关注 chip——不每次刷新都拉 25KB。
    if (Date.now() - OV_KEYS_AT > 60000) {
      OV_KEYS_AT = Date.now();
      api('keys?slim=1').then((d) => { OV_KEYS_CACHE = d.keys || []; }).catch(() => { OV_KEYS_AT = 0; });  // slim（manual#293）：chip 只用 keyState 的四个字段，全量的 policy/authFailures 是死重
    }
    // 分级刷新（manual#296）：易变数据（overview/series/providers）每刷都取；稳定数据
    // （kb/agent，~30min 才变）走 60s 缓存——首屏等取、之后命中缓存零请求。
    const kbFresh = !!OV_KB_CACHE && Date.now() - OV_KB_AT <= 60000;
    const agentFresh = !!OV_AGENT_CACHE && Date.now() - OV_AGENT_AT <= 60000;
    if (!kbFresh) OV_KB_AT = Date.now();
    if (!agentFresh) OV_AGENT_AT = Date.now();
    const [ov, ser, kbState, agentState, prov] = await Promise.all([api('overview?window=' + win() + '&slim=1'), api('series?window=' + win() + '&bucketMs=' + bucket()),
      kbFresh ? Promise.resolve(OV_KB_CACHE) : capSafe('kb').then((d) => { if (d && (d.enabled || d.kbs)) OV_KB_CACHE = d; return d; }),
      agentFresh ? Promise.resolve(OV_AGENT_CACHE) : capSafe('agent').then((d) => { if (d && d.enabled) OV_AGENT_CACHE = d; return d; }),
      api('providers?slim=1').catch(() => ({ reachability: [] }))]);  // slim（manual#292）：ov 页只用可达性，快照与 overview 重复（64% 载荷）——每 15s 刷新都省
    const s = ov.summary, lr = s.lossReduction;
    const open = ov.providers.filter((p) => p.breakerOpen).length;
    $('ver').textContent = (SITE_VERSION ? 'v' + SITE_VERSION + ' · ' : '') + ov.providers.length + ' 上游' + (open ? '（熔断 ' + open + '）' : '');

    const bars = (ser.points || []).length
      ? (() => { const max = Math.max.apply(null, ser.points.map((p) => p.requests)) || 1;
          // tooltip 补齐成本与均耗时（manual#174）：series 每桶早算 costCny/avgDurationMs，
          // 此前 tooltip 只显 4/6 字段——成本按桶分布（哪个时段在花钱）只能靠翻账本。
          return ser.points.map((p) => '<div class="b" title="' + esc(TS(p.ts) + ' · 请求 ' + p.requests + ' · 错误 ' + p.errors + ' · token ' + p.tokens + ' · 成本 ' + cny(p.costCny) + ' · 均耗时 ' + ms(p.avgDurationMs)) + '"><div class="fill' + (p.errors > 0 ? ' f' : '') + '" style="height:' + Math.max(2, Math.round((p.requests / max) * 84)) + 'px"></div></div>').join(''); })()
      : emptyBox('📊', '窗口内还没有请求', '跑一次调用就能看到数据');

    // 平台能力读数（manual#76）：KB/Agent 拉取失败时降级为「未启用」，不影响总览其余部分
    const kbs = (kbState && kbState.kbs) || [];
    const kbDocs = kbs.reduce((a, k) => a + ((k.stats && k.stats.docs) || 0), 0);
    const kbChunks = kbs.reduce((a, k) => a + ((k.stats && k.stats.chunks) || 0), 0);
    const agSt = (agentState && agentState.status) || {};
    const agLast = agSt.lastRun || null;
    // 重启前标记（manual#277）：lastRun 可能是事件重建的（fromEvent）——此时『N 轮』是
    // 进程内计数（0）而『最近 X』是全时（含重启前），两个口径混在一行会读成『从没跑过但
    // 又有最近记录』。给重建的记录加与 Agent 页 chip 同款的『重启前』标记，口径自明。
    const agLastTxt = agLast
      ? (TS(agLast.startedAt) + ' · ' + ((agLast.decision && agLast.decision.kind) || '-') + (agLast.fromEvent ? '（重启前·事件重建）' : ''))
      : '尚无运行记录';
    // 错题本状态（manual#108）：用户 round-100 指令把 KB 校准文档定为运维错题本——平台能力区
    // 展示其保鲜度。Agent 同款查询的 top1 即校准文档：检索分高=错题本在位（Agent 每轮必读），
    // 分数跌落=错题本失位需校准。KB 未启用时不发这个请求（避免双倍失败调用）。
    const ebState = (kbState && kbState.enabled)
      ? await api('kb/kb-demo/search', { method: 'POST', body: JSON.stringify({ query: '迭代 优化 运维', topK: 1 }) })
          .then((r) => (r.results || [])[0] || null).catch(() => null)
      : null;
    // 聚合站 8767 存活探测（manual#123）：两站合并后 B 站状态只在运维页深处（#85 的嵌入区）
    // 可见——平台能力区补一行，第一屏幕就看到合并站两半各自什么状态。探测模式同 #85
    // （no-cors+3s 超时；停机时连接拒绝立即失败，不拖累 15s 自动刷新的渲染）。
    let bUp = false;
    try {
      const bc = new AbortController();
      const bt = setTimeout(() => bc.abort(), 3000);
      try { await fetch('http://127.0.0.1:8767/healthz', { mode: 'no-cors', signal: bc.signal }); bUp = true; }
      finally { clearTimeout(bt); }
    } catch { bUp = false; }

    $('main').innerHTML = \`
      \${statusBanner(ov, s)}
      <div class="note">
        <button class="bare" id="ov-brief" style="float:right;margin-left:10px" title="把本页关键读数聚成一段纯文本复制走——交接班/群里通报用">📋 一键值班摘要</button>\${ovRiskChip()}
        <b>这张表回答三个问题：</b>现在健康吗？降损层在起作用吗？下一步该优化什么？
        「归因投递率」= 错误被翻译成可执行下一步的比例；「降损层开销」= 预检+归因耗时占总耗时比例（治理层不该超过千分之一）。
      </div>
      <div class="grid cards">
        \${tile('请求数', formatNumber(s.overall.requests), '错误 ' + formatNumber(s.overall.errors) + '（<span class="' + rateCls(s.overall.errorRate) + '">' + pct(s.overall.errorRate) + '</span>）')}
        \${tile('Token 用量', formatNumber(s.overall.totalTokens), '上游成本 <b>¥' + Number(s.overall.costCny).toFixed(4) + '</b>（实付）· 牌面价 ¥' + Number(s.overall.listCostCny ?? 0).toFixed(4))}
        \${tile('p95 延迟', ms(s.overall.p95Ms), '平均 ' + ms(s.overall.avgTtfbMs))}
        \${tile('归因投递率', '<span class="' + (lr.attributionCoverage >= .8 ? 'ok' : 'warn') + '">' + pct(lr.attributionCoverage) + '</span>', '错误被翻译成可执行下一步的比例')}
        \${tile('自动恢复', '<span class="ok">' + formatNumber(lr.autoRecovered) + '</span>', '重试后成功，用户少一次人工介入')}
        \${tile('无效重试', formatNumber(lr.duplicateRetries), '同 key 60s 内重复发送相同请求')}
        \${tile('预检拦截', formatNumber(lr.precheckBlocked), '畸形调用在上游之前被拦下')}
        \${tile('降损层开销', '<span class="' + (lr.overheadRatio < .001 ? 'ok' : 'warn') + '">' + (lr.overheadRatio * 100).toFixed(4) + '%</span>', '预检 ' + formatNumber(ov.overheadUs.precheck) + 'µs + 归因 ' + formatNumber(ov.overheadUs.classify) + 'µs')}
      </div>

      <section class="block" style="margin-top:14px"><h2>平台能力 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">知识库与内部 Agent 的实时状态（manual#76 新增）</span></h2>
        <table>
          <tr><th>能力</th><th>状态</th><th>关键读数</th><th>入口</th></tr>
          <tr><td>知识库（KB）</td><td>\${kbState && kbState.enabled ? '<span class="ok">启用</span>' : '<span class="warn">未启用</span>'}</td><td class="mono"\${kbState && kbState.enabled && kbState.config ? ' title="' + esc(kbState.config.path + ' · 分块 ' + kbState.config.chunkSize + ' 字 / 重叠 ' + kbState.config.chunkOverlap + ' 字') + '"' : ''}>\${kbState && kbState.enabled ? formatNumber(kbs.length) + ' 个库 · ' + formatNumber(kbDocs) + ' 文档 · ' + formatNumber(kbChunks) + ' 分块' + (kbState.config ? ' <span class="dim">· ' + esc(kbState.config.path) + '</span>' : '') : '配置 kb.path 后重启生效'}</td><td><a href="#kb">知识库页签</a></td></tr>
          <tr><td>内部 Agent</td><td>\${agentState && agentState.enabled ? (agSt.running ? '<span class="ok">运行中</span>' : '<span class="ok">启用 · 空闲</span>') : '<span class="warn">未启用</span>'}</td><td class="mono">\${agentState && agentState.enabled ? '模型 ' + esc(agSt.model) + ' · ' + formatNumber(agSt.runCount) + ' 轮 · 最近 ' + esc(agLastTxt) : '配置 agent.enabled 后重启生效'}</td><td><a href="#agent">Agent 页签</a></td></tr>
          <tr><td>错题本（运维基线）</td><td>\${ebState ? '<span class="ok">在维护</span>' : '<span class="warn">不可用</span>'}</td><td class="mono">\${ebState ? esc(ebState.docTitle) + ' · 检索分 ' + ebState.score + '（Agent 每轮必读）' : (kbState && kbState.enabled ? '校准文档未命中 top1——错题本可能失位，需校准' : '配置 kb.path 后重启生效')}</td><td><a href="#kb">知识库页签</a></td></tr>
          <tr><td>聚合站（8767 · B）</td><td>\${bUp ? '<span class="ok">运行中</span>' : '<span class="warn">未运行</span>'}</td><td class="mono">\${bUp ? 'hermes 面板可嵌入，渠道/用户/账本在运维页操作' : '停机中——重启前需验证 tokenrhythm key 与余额（门控，见错题本）'}</td><td><a href="#ops">运维页嵌入</a></td></tr>
        </table>
      </section>

      <div class="grid two" style="margin-top:14px">
        <section class="block"><h2>请求 / 错误 时间序列 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">蓝=成功为主，红=该桶有错误</span></h2>
          <div class="bars">\${bars}</div>
          <div class="bars-axis">\${(ser.points || []).map((p, i, arr) => {
            const step = Math.max(1, Math.ceil(arr.length / 5));
            const show = i % step === 0 || i === arr.length - 1;
            // 轴标签按桶粒度切格式（manual#169）：日桶（7d/30d，桶=86400000）的起点全是同日时刻
            // （实测 8 个日桶全在 08:00）——用 toLocaleTimeString 会显示 8 个一样的「08:00」，
            // 完全分不清哪天。日桶改显 MM-DD；时/分桶仍显 HH:MM。
            const axisLabel = bucket() >= 86400000
              ? new Date(p.ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
              : new Date(p.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
            return '<span>' + (show ? axisLabel : '') + '</span>';
          }).join('')}</div>
          <div class="dim" style="font-size:11px;margin-top:6px">每桶 \${bucket() >= 86400000 ? (bucket() / 86400000) + ' 天' : (bucket() / 60000) + ' 分钟'} · 共 \${(ser.points || []).length} 桶（轴标注部分桶的起始时刻，每桶精确数值 hover 柱子看）</div>
        </section>
        <section class="block"><h2>降损层收益（P2 / P3 / P8）</h2>
          <table>
            <tr><th>口径</th><th>值</th><th>它决定什么</th></tr>
            <tr><td>归因投递率</td><td class="mono">\${pct(lr.attributionCoverage)}</td><td class="dim">低于 80% 说明有失败模式没被规则覆盖</td></tr>
            <tr><td>自动恢复成功</td><td class="mono ok">\${formatNumber(lr.autoRecovered)}</td><td class="dim">用户少一次人工介入</td></tr>
            <tr><td>重复请求（60s）</td><td class="mono">\${formatNumber(lr.duplicateRetries)}</td><td class="dim">高 → 引导用户加同轮去重</td></tr>
            <tr><td>预检拦截</td><td class="mono">\${formatNumber(lr.precheckBlocked)}</td><td class="dim">每条省一次上游往返</td></tr>
            <tr><td>预检降级放行</td><td class="mono \${lr.precheckDegraded ? 'warn' : 'ok'}">\${formatNumber(lr.precheckDegraded)}</td><td class="dim">fail-open 次数，应为 0</td></tr>
          </table>
        </section>
      </div>

      <div class="grid two" style="margin-top:14px">
        <section class="block"><h2>失败归因分布 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">上游错误被翻译成了什么</span></h2>
          \${(s.byFailureReason || []).length ? (s.byFailureReason || []).map((r) => bar({ nm: r.reason, val: r.count, txt: formatNumber(r.count) + ' · 可恢复 ' + pct(r.recoverablePct) }, Math.max.apply(null, s.byFailureReason.map((x) => x.count)), 'r')).join('') : emptyBox('✅', '窗口内没有失败', '这是好消息；有失败时这里会按原因分布')}
          \${(s.byQuickAction || []).length ? '<h2 style="margin-top:14px">建议动作分布（模型拿到的是动作而不是猜谜）</h2>' + (s.byQuickAction || []).map((a) => bar({ nm: a.action, val: a.count, txt: formatNumber(a.count) }, Math.max.apply(null, s.byQuickAction.map((x) => x.count)))).join('') : ''}
        </section>
        <section class="block"><h2>分层 × 客户类型</h2>
          <table><tr><th>分层（档位）</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr>
          \${(s.byTier || []).map((r) => {
            // 档位名与策略取自 overview.tiers（manual#199，config.tiers 真源）——删掉此前的静态
            // TIER_LABEL/TIER_DESC 映射（运营改名/调参后 ov 显旧值、ops 显新值，同档位两套词汇）。
            const tp = (ov.tiers || {})[r.key];
            const desc = tp ? '预检 ' + esc(tp.precheck) + ' · 归因 ' + esc(tp.attribution) + ' · rpm ' + formatNumber(tp.rpm) + ' · 并发 ' + formatNumber(tp.maxConcurrency) : '';
            return '<tr><td>' + (tp ? '<b>' + esc(tp.label) + '</b> <span class="dim mono" style="font-size:11px">' + esc(r.key) + '</span>' +
              (desc ? '<div class="dim" style="font-size:11px">' + desc + '</div>' : '')
              : esc(r.key)) + '</td><td class="mono num">' + formatNumber(r.requests) + '</td><td class="mono num ' + rateCls(r.errorRate) + '">' + pct(r.errorRate) + '</td><td class="mono num">' + formatNumber(r.totalTokens) + '</td><td class="mono num">' + cny(r.costCny) + '</td></tr>';
          }).join('')}
          <tr><th>客户类型</th><th>请求</th><th>错误率</th><th colspan="2">p95</th></tr>
          \${(s.byClientKind || []).map((r) => '<tr><td>' + esc(r.key) + '</td><td class="mono num">' + formatNumber(r.requests) + '</td><td class="mono num">' + pct(r.errorRate) + '</td><td class="mono num" colspan="2">' + ms(r.p95Ms) + '</td></tr>').join('')}
          </table>
        </section>
      </div>

      <section class="block" style="margin-top:14px"><h2>按上游 / 按模型 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">窗口内请求量·错误率·成本（manual#101：overview 早有 byProvider/byModel 数据，总览页此前不展示——错题本头号问题 stepfun 46.7% 需要主屏永久位）</span></h2>
        <div class="grid two">
          <section class="block"><h2>上游</h2>
            <table><tr><th>上游</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr>
            \${(s.byProvider || []).map((r) => '<tr><td class="mono">' + esc(r.key) + '</td><td class="mono num">' + formatNumber(r.requests) + '</td><td class="mono num ' + rateCls(r.errorRate) + '">' + pct(r.errorRate) + '</td><td class="mono num">' + formatNumber(r.totalTokens) + '</td><td class="mono num">' + cny(r.costCny) + '</td></tr>').join('') || '<tr><td colspan="5" class="dim">窗口内无请求</td></tr>'}
            </table>
          </section>
          <section class="block"><h2>模型 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">「未声明」= 任何上游与别名都不可路由（manual#105）</span></h2>
            <table><tr><th>模型</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr>
            \${(s.byModel || []).map((r) => {
              const routable = ((prov && prov.reachability) || []).some((x) => x.model === r.key);
              return '<tr><td class="mono">' + esc(r.key) + (routable ? '' : ' <span class="chip r" title="没有任何上游声明该模型、也无别名指向它——客户端请求了本网关不存在的模型">未声明</span>') + '</td><td class="mono num">' + formatNumber(r.requests) + '</td><td class="mono num ' + rateCls(r.errorRate) + '">' + pct(r.errorRate) + '</td><td class="mono num">' + formatNumber(r.totalTokens) + '</td><td class="mono num">' + cny(r.costCny) + '</td></tr>';
            }).join('') || '<tr><td colspan="5" class="dim">窗口内无请求</td></tr>'}
            </table>
          </section>
        </div>
      </section>\`;
    const riskBtn = $('ov-risk');
    // manual#334 修真 bug：此前写 '#/keys'——既带斜杠又用了不存在的页签 id（客户 Key 页的
    // id 是 users）。hashTab() 对 '#/keys' 回退 'ov'，而 chip 就在 ov 页——t===VIEW 直接
    // no-op，跳转从未生效（只设了 KEY_FILTER，用户留在原页）。改 'users'（TAB_IDS 内的真 id）。
    if (riskBtn) riskBtn.addEventListener('click', () => { KEY_FILTER = 'risk'; location.hash = 'users'; });
    const briefBtn = $('ov-brief');
    if (briefBtn) briefBtn.addEventListener('click', async () => {
      try {
        // Key 预警按需取数（manual#162）：ov 页每 15s 自动刷新，keys 不常驻内存——
        // 点摘要时才取（本地库查询，一次调用成本可忽略）；取数失败不阻塞摘要其余行。
        let keys = null;
        try { keys = (await api('keys')).keys; } catch { /* 取不到就跳过预警行 */ }
        const txt = buildShiftBrief(ov, s, agentState, bUp, kbs.reduce((n, k) => n + ((k.stats && k.stats.docs) || 0), 0), keys);
        await copyText(txt, '值班摘要已复制到剪贴板（可直接粘贴到 IM/邮件）');
      } catch (e) { toast('生成摘要失败：' + esc(e.message), 'r'); }
    });
  }

  /* ============ 指标（原始读数，回答"这个数为什么是这个值"） ============ */
  async function vMet() {
    // 并行取 health（manual#125）：路由契约审计发现 admin/api/health 是唯一 GUI 未调的路由——
    // 它的 server.inflight（在途请求数）是上游挂起时的即时信号（错误率是滞后的），
    // 补进程行里；取不到不影响本页其余部分（catch 兜底）。
    const [d, hx] = await Promise.all([api('metrics?window=' + win()), api('health').catch(() => null)]);
    const inflight = (hx && hx.server && Number(hx.server.inflight)) || 0;
    // health 其余字段消费（manual#177）：server.requestCount（进程累计请求）与 providers
    // （上游摘要 total/disabled/breakerOpen）——进程行此前只用 inflight，这两个字段白取。
    const reqCount = (hx && hx.server && Number(hx.server.requestCount)) || 0;
    // admin 令牌失败计数（manual#177 续 #177）：health.adminAuth——暴力破解的体温计，
    // 恒 0 是常态；>0 说明有人在试令牌（Funnel 暴露面），琥珀色以上要查来源。
    const aaFails = (hx && hx.adminAuth && Number(hx.adminAuth.total)) || 0;
    const hp = (hx && hx.providers) || {};
    const hpTotal = Number(hp.total) || 0, hpDis = Number(hp.disabled) || 0, hpBrk = Number(hp.breakerOpen) || 0;
    const cs = Object.entries(d.counters || {}).sort((a, b) => b[1] - a[1]);
    const ss = Object.entries(d.summaries || {});
    const der = Object.entries(d.derived || {});
    // 进程年龄（manual#116）：metrics 本就带 uptimeS，此前没用上。本页计数器全是"进程累计、
    // 重启清零"——进程多大年纪直接决定这些数字的可信区间；运营改配置重启后，这里立即显示
    // 新进程的年龄（重启生效可见，不用登服务器看 PID/ps）。
    const upS = Number(d.uptimeS) || 0;
    const upTxt = upS >= 3600 ? Math.floor(upS / 3600) + ' 小时 ' + Math.floor((upS % 3600) / 60) + ' 分'
      : upS >= 60 ? Math.floor(upS / 60) + ' 分 ' + (upS % 60) + ' 秒'
      : upS + ' 秒';
    // 存储健康（manual#117）：metrics payload 一直带 store（driver/ok/pendingWrites/degradedEvents/
    // lastFlushAt），此前全站无展示。待写>0=落库积压（度量/轨迹在排队）；降级事件>0=存储层
    // fail-open 过（A3 铁律「绝不因治理层挂而拒绝请求」的运行证据——和预检降级放行同一性质）。
    // 派生比率释义（manual#137）：原始读数页也不能只报数字——ov 页的降损收益表早有
    // 「它决定什么」列，指标页这三个比率的读者（调试中的运营）更需要提示。
    const DERIVED_HINT = {
      'relay.attribution.coverage': '错误中被归因规则覆盖的比例；低于 80% 说明有失败模式没被规则覆盖（排障页看归因目录）',
      'relay.error.rate': '窗口错误率；持续 >50% 先看总览横幅点名的主因，再到对应页处理',
      'relay.overhead.ratio': '治理层（预检+归因）耗时占总耗时比；<0.1% 为健康——治理层不该成为瓶颈',
    };
    const st2 = d.store || {};
    const stOk = st2.ok !== false;
    const stDeg = Number(st2.degradedEvents) || 0;
    const stPend = Number(st2.pendingWrites) || 0;
    const stFlush = st2.lastFlushAt ? dayTime(st2.lastFlushAt) : '—';
    const cls = Object.entries(d.classCounters || {});
    $('ver').textContent = (SITE_VERSION ? 'v' + SITE_VERSION + ' · ' : '') + 'uptime ' + formatNumber(d.uptimeS) + 's';

    $('main').innerHTML = \`
      <div class="note">
        <b>这一页是"原始读数"，不是业务结论。</b>总览回答"业务上怎么样"，这里回答"这个数为什么是这个值"。
        命名对齐 OpenTelemetry GenAI 语义约定（<span class="mono">gen_ai.client.*</span>），<span class="mono">relay.*</span> 是本网关的本地扩展。
      </div>

      <section class="block"><h2>降损层自证指标 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">治理层不该成为瓶颈，也不该静默失效</span></h2>
        <div class="grid cards">
          \${tile('治理层开销占比', '<span class="' + (d.derived['relay.overhead.ratio'] < .001 ? 'ok' : 'warn') + '">' + (d.derived['relay.overhead.ratio'] * 100).toFixed(4) + '%</span>', '预检+归因耗时 / 总耗时')}
          \${tile('错误率', pct(d.derived['relay.error.rate']))}
          \${tile('归因覆盖', pct(d.derived['relay.attribution.coverage']), '错误中带回归因的比例')}
          \${tile('预检降级放行', '<span class="' + (d.classCounters['relay.preflight.degraded'] ? 'warn' : 'ok') + '">' + formatNumber(d.classCounters['relay.preflight.degraded']) + '</span>', 'fail-open 次数，应恒为 0')}
          \${tile('成功但零 token', '<span class="' + (d.zeroTokenCount ? 'err' : 'ok') + '">' + formatNumber(d.zeroTokenCount) + '</span>', '静默少记的体温计，应恒为 0；>0 去「排障 → 事件日志」看 meter.zero_token')}
        </div>
      </section>

      <div class="grid two" style="margin-top:14px">
        <div class="note" style="margin-bottom:10px">网关进程已运行 <b>\${esc(upTxt)}</b> · 累计请求 <b>\${formatNumber(reqCount)}</b> · 在途请求 <b>\${formatNumber(inflight)}</b> · 上游 <b>\${formatNumber(hpTotal)}</b> 个（停用 \${formatNumber(hpDis)} / 熔断 \${formatNumber(hpBrk)}） · 令牌失败 <span class="\${aaFails > 0 ? 'err' : 'ok'}">\${formatNumber(aaFails)}</span>——本页计数器都是这个进程启动以来的累计值；刚重启过的话数字偏小是正常的。在途持续偏高=上游响应慢或卡住（比错误率更早的信号）；上游停用/熔断数>0 时去「上游」页看是哪个。令牌失败>0=有人在试管理令牌（本进程累计，重启清零）——持续增长要查来源 IP 并考虑改令牌。</div>
        <div class="note" style="margin-bottom:10px">存储 <b>\${esc(st2.driver || '未知')}</b> · 状态 <span class="\${stOk ? 'ok' : 'err'}">\${stOk ? '正常' : '异常'}</span> · 待写 <span class="\${stPend > 100 ? 'warn' : ''}">\${formatNumber(stPend)}</span> · fail-open <span class="\${stDeg > 0 ? 'err' : 'ok'}">\${formatNumber(stDeg)} 次</span> · 最后刷盘 \${esc(stFlush)}——待写堆积=落库排队，fail-open>0=存储层曾异常降级（A3 铁律证据，同预检降级放行一个性质）。</div>
        <section class="block"><h2>计数器（进程累计，重启清零）<span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">不受上方窗口选择影响（manual#107）</span></h2>
          <input id="mc-q" placeholder="🔍 过滤计数器名（如 precheck）" style="width:100%;margin-bottom:8px">
          <table id="mc-table"><tr><th>counter</th><th style="text-align:right">值</th></tr>
          \${cs.map(([k, v]) => '<tr><td class="mono">relay.' + esc(k) + '</td><td class="mono" style="text-align:right">' + formatNumber(v) + '</td></tr>').join('')}
          </table>
          <h2 style="margin-top:14px">分类计数</h2>
          <table><tr><th>指标</th><th style="text-align:right">值</th></tr>
          \${cls.map(([k, v]) => '<tr><td class="mono">' + esc(k) + '</td><td class="mono" style="text-align:right">' + formatNumber(v) + '</td></tr>').join('')}
          </table>
        </section>
        <section class="block"><h2>分布（n / avg / min / max）</h2>
          <table><tr><th>指标</th><th>n</th><th>avg</th><th>min</th><th>max</th></tr>
          \${ss.map(([k, v]) => '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + formatNumber(v.count) + '</td><td class="mono">' + (v.avg < 10 ? v.avg.toFixed(2) : formatNumber(v.avg, 1)) + '</td><td class="mono">' + formatNumber(v.min, 1) + '</td><td class="mono">' + formatNumber(v.max, 1) + '</td></tr>').join('')}
          </table>
          <h2 style="margin-top:14px">派生比率</h2>
          <table><tr><th>口径</th><th class="num">值</th><th>它决定什么</th></tr>
          \${der.map(([k, v]) => '<tr><td class="mono">' + esc(k) + '</td><td class="mono" style="text-align:right">' + (String(k).includes('ratio') || String(k).includes('rate') || String(k).includes('coverage') ? pct(v) : formatNumber(v, 4)) + '</td><td class="dim">' + esc(DERIVED_HINT[k] || '') + '</td></tr>').join('')}
          </table>
          <div class="dim" style="font-size:11px;margin-top:8px">\${esc(d.nameNote || '')}</div>
        </section>
      </div>\`;

    // 计数器过滤（manual#107）：~25 个计数器平铺，找 specific counter 要人肉扫描；
    // 只重画表格主体保住输入焦点（同 ledger/keys 模式）。计数器是进程累计，
    // 与上方窗口选择无关——标题已明示，避免「换了窗口数字不变」的困惑。
    const mcHead = '<tr><th>counter</th><th style="text-align:right">值</th></tr>';
    const paintMc = () => {
      const q = ($('mc-q').value || '').trim().toLowerCase();
      const rows = cs.filter(([k]) => k.toLowerCase().includes(q))
        .map(([k, v]) => '<tr><td class="mono">relay.' + esc(k) + '</td><td class="mono" style="text-align:right">' + formatNumber(v) + '</td></tr>').join('');
      $('mc-table').innerHTML = mcHead + (rows || '<tr><td colspan="2" class="dim">没有匹配的计数器</td></tr>');
    };
    $('mc-q').addEventListener('input', paintMc);
  }

  /* ============ 客户 Key ============ */
  function authFailHtml(af, winAuth) {
    // 空台账时把落库的窗口计数显出来（manual#256）：此前只说「累计量在总览横幅里」——
    // 运营还要自己切页去看；现在 keys 页直接显「窗口内 N 次（落库，跨重启）」。
    const win = winAuth && winAuth.count ? ' <b>窗口内 ' + formatNumber(winAuth.count) + ' 次</b>（落库统计，跨重启仍在；最近 ' + TS(winAuth.lastAt) + '）' : '';
    if (!af || !af.total) return '<div class="dim" style="font-size:12px;margin-top:8px">本进程启动以来没有被拒的 key。' +
      '（指纹台账只在内存里，重启即清空；"被拒了 N 次"这种累计量在「总览」横幅与失败统计里，那份是落库的，跨重启仍在。）' +
      (win ? '<br>当前窗口：' + win.trim() + '。' : '') + '</div>';
    const g = (af.groups || []).slice(0, 8);
    return '<h2 style="margin-top:14px">最近被拒的 key <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">本进程启动以来共 ' + formatNumber(af.total) + ' 次 · ' + formatNumber(af.distinct) + ' 种 · 指纹与下方「指纹」列同口径，可直接对照</span></h2>' +
      '<table><tr><th>指纹</th><th>原因</th><th>次数</th><th>最后时间</th><th>对照</th><th>提交形态</th></tr>' +
      g.map((x) => '<tr><td class="mono">' + esc(x.fingerprint || '(没带 key)') + '</td>' +
        '<td class="mono">' + esc(x.code) + '</td>' +
        '<td class="mono">' + formatNumber(x.count) + '</td>' +
        '<td class="mono">' + TS(x.lastAt) + '</td>' +
        '<td><span class="chip ' + (x.matchesIssuedKey ? 'y' : 'r') + '">' + (x.matchesIssuedKey ? '命中已签发 key（可能被禁用/过期）' : '非本网关签发') + '</span></td>' +
        '<td class="mono">' + (x.headerForm === 'none' ? '没带' : x.headerForm === 'bearer' ? 'Bearer' : '裸 key') + '</td></tr>').join('') +
      '</table>';
  }

  /** 客户 Key 表格行（筛选/搜索时只重画这部分，输入框不会失焦） */
  const KEY_THEAD = '<tr><th>Key</th><th>指纹</th><th>备注</th><th>分层</th><th>来源</th><th>状态</th><th class="num">本周期用量 / 额度</th><th>RPM / 并发</th><th class="act">操作</th></tr>';

  function renderKeyRows(rows) {
    return KEY_THEAD + rows.map((k) => {

              const u = k.usage || {};
              const p = u.quotaUsedPct;
              const pcls = p == null ? '' : p > .9 ? 'r' : p > .7 ? 'y' : 'g';
              const used = u.quota
              ? '<b>' + formatNumber(u.tokens) + '</b> <span class="dim">/ ' + formatNumber(u.quota) + '</span>'
              : '<b>' + formatNumber(u.tokens) + '</b> <span class="dim">/ 不限</span>';
              // 按钱的额度单独一行：它对输入/输出比例不敏感，是客户真正对得上的那种口径。
              // 进度条补上（manual#368）：卖 key 的预算帽是钱的口径，此前只有小字百分比——
              // 17 把 key 里找哪把快耗尽要逐行读数字；与 token 行同款 r/y/g 分级（>90% 红）。
              const cnyPct2 = u.quotaCnyUsedPct ?? 0;
              const cnyCls2 = cnyPct2 > .9 ? 'r' : cnyPct2 > .7 ? 'y' : 'g';
              const cnyLine = u.quotaCny
                ? '<div style="font-size:11px" class="' + (cnyPct2 > .9 ? 'warn' : 'dim') + '">' + cny(u.costCny || 0) + ' / ' + cny(u.quotaCny) + ' <span class="dim">(' + pct(cnyPct2) + ')</span>' +
                  bar({ nm: '', val: cnyPct2, txt: '' }, 1, cnyCls2).replace(/<span class="nm">.*?<\\/span>|<span class="vl">.*?<\\/span>/g, '') + '</div>'
                : '<div class="dim" style="font-size:11px">' + cny(u.costCny || 0) + ' / 不限</div>';
              // 状态判定统一走 keyState（manual#160）：与「需关注」筛选共用一处阈值——
              // 曾有两份判定的风险（筛选与 chip 各算各的），抽 helper 后只此一份。
              // "用户用完就结束"必须一眼看得见：token 额度或 ¥ 预算任一耗尽即视为用完，
              // 此时请求会被 402 拒掉，但 key 本身还挂着 —— 不给状态就容易被当成"还能用"。
              const ks2 = keyState(k);
              const st = !k.enabled ? '<span class="chip">已禁用</span>'
                : ks2.usedUp ? '<span class="chip r" title="额度/预算已耗尽，请求会被 402 拒掉；充值后在「编辑」里提额或点「重置额度」即可恢复">已用完</span>'
                : ks2.expired ? '<span class="chip y" title="已过有效期，请求会被拒；到「编辑」里续期即可恢复">已过期</span>'
                : ks2.expiringSoon ? '<span class="chip y" title="' + ks2.expDays + ' 天后过期——提前通知客户换 key 或到「编辑」里续期">' + ks2.expDays + ' 天后过期</span>'
                : ks2.nearLimit ? '<span class="chip y" title="本周期额度/预算即将耗尽（≥85%），客户很快会被 402 拒；提前联系充值或提额">将耗尽</span>'
                : '<span class="chip g">生效中</span>';
              const tierCls = k.tier === 'pro' ? 'p' : k.tier === 'free' ? '' : 'b';
              return '<tr><td class="mono">' + esc(k.id) + '</td><td class="mono" style="font-size:11px">' + esc(k.hashPrefix) + '</td><td>' + shortLabel(k.label, 40) + '</td>' +
                '<td><span class="chip ' + tierCls + '">' + esc(k.tier) + '</span></td>' +
                '<td><span class="chip ' + (k.origin === 'panel' ? 'p' : 'b') + '">' + (k.origin === 'panel' ? '面板' : '配置') + '</span></td><td>' + st + '</td>' +
                '<td class="mono num">' + used + (p == null ? '' : bar({ nm: '', val: p, txt: '' }, 1, pcls).replace(/<span class="nm">.*?<\\/span>|<span class="vl">.*?<\\/span>/g, '')) +
                '<div class="dim" style="font-size:11px">' + formatNumber(u.requests) + ' 次</div>' + cnyLine + '</td>' +
                '<td class="mono" style="font-size:11px;white-space:nowrap">RPM ' + (k.policy.rpm == null ? '∞' : k.policy.rpm) + ' · 并发 ' + (k.concurrency ? k.concurrency.active : 0) + '/' + (k.policy.maxConcurrency == null ? '∞' : k.policy.maxConcurrency) + '</td>' +
                '<td class="act">' +
                '<button data-act="edit" data-id="' + esc(k.id) + '" title="改备注 / 分层 / 型号白名单 / 额度">编辑</button>' +
                '<button class="bare" data-act="reset" data-id="' + esc(k.id) + '" title="本周期已用量清零（历史度量保留）；客户充值后点它立刻恢复">重置</button>' +
                // 轮换与停用是**不可逆**的（旧 key 立即失效 / 该 key 立刻不能调），
                // 所以从"随手能点"的行内挪进抽屉，避免误触（真实发生过一次误点轮换）。
                '<button class="bare" data-act="more" data-id="' + esc(k.id) + '" title="轮换 / 启用停用">更多…</button>' +
                '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="dim" style="padding:18px;text-align:center">这个筛选下没有 key。换个条件，或点右上角「+ 新建 Key」。</td></tr>';
  }
  // events 全量详情按需（manual#301）：表格拉 detail=0 的 slim 行（kind=agent 省 63%——
  // 证据数组是详情大户），抽屉/CSV 才拉全量：首次拉一次、按当前查询缓存、换筛选自然失效
  // （traces 页 #163 的『列表 slim+详情按需』模式，events 是最后一个照做的页面）。
  let EV_FULL = { q: null, rows: null };
  const evFullQuery = () => (EV_FILTER === 'all' ? 'events?limit=100' : 'events?limit=200&kind=' + encodeURIComponent(EV_FILTER)) + evLevelQuery();
  const ensureEvFull = async () => {
    const q = evFullQuery();
    if (EV_FULL.q === q && EV_FULL.rows) return EV_FULL.rows;
    const d = await api(q);
    EV_FULL = { q, rows: d.events || [] };
    return EV_FULL.rows;
  };
  // 客户 Key 页的筛选状态：默认只看"生效中"，因为停用过的历史 key 通常是噪音
  // 持久化（manual#223，#205 线程续）：keys 页的状态筛选与搜索词刷新不丢。
  let KEY_FILTER = 'on';
  let KEY_Q = '';
  try {
    const _kf = localStorage.getItem('relay_admin_key_filter');
    if (_kf && ['on', 'off', 'risk', 'all'].includes(_kf)) KEY_FILTER = _kf;
    KEY_Q = localStorage.getItem('relay_admin_key_q') || '';
  } catch { /* 隐私模式忽略 */ }
  // ov 页的需关注 chip 缓存（manual#221）：keys 有 25KB，不能进 15s 刷新循环——
  // 60s 缓存够用（预警不是秒级信号），首次进 ov 页并行取，之后按年龄刷新。
  let OV_KEYS_CACHE = null;
  // kb/agent 状态的 60s 缓存（manual#296，#221 keys 同款）：这两份数据的自然变化率是
  // ~30min 级（KB 统计随文档灌入变、agent 状态随运行变），15s 刷新粒度对它们是浪费
  // （合计 ~2.9KB/次，agent 还带一次事件扫描）。首屏缓存空时照常等取（不闪『未启用』），
  // 此后 60s 内的刷新直接用缓存；取败不缓存（下次刷新重试）。
  let OV_KB_CACHE = null;
  let OV_KB_AT = 0;
  let OV_AGENT_CACHE = null;
  let OV_AGENT_AT = 0;
  // 模型名缓存（manual#262，#221 同款 60s TTL）：keyForm 的「允许模型」是自由文本——
  // 打错一个字母客户全量 404。datalist 数据源走 /providers 的 reachability（全部可达
  // 模型名），60s 缓存避免每次开表单都拉。
  let MODEL_NAMES = [];
  let MODEL_NAMES_AT = 0;
  const refreshModelNames = () => {
    // 返回 promise（manual#316）：调用方（whoami 自检）要等缓存热好再渲染未声明标记——
    // 此前 fire-and-forget 有竞态：刷新没回来时标记按 #281 设计降级成纯文本（时好时坏）。
    // 幂等命中（60s TTL 内）返回已解决的 promise，不产生请求。
    if (Date.now() - MODEL_NAMES_AT <= 60000) return Promise.resolve();
    MODEL_NAMES_AT = Date.now();
    return api('providers?slim=1').then((d) => {  // slim（manual#298）：模型名只从 reachability 取——快照部分（64%）用不上
      MODEL_NAMES = (d.reachability || []).map((r) => r.model).filter(Boolean);
      const dl = $('f-models-list');
      if (dl) dl.innerHTML = MODEL_NAMES.map((m) => '<option value="' + esc(m) + '">').join('');
    }).catch(() => { MODEL_NAMES_AT = 0; });
  };
  let OV_KEYS_AT = 0;

  // key 关注判定（manual#160 抽自 #153/#158 的行内逻辑）：启用中且存在任何事前/事后的
  // 异常状态——临期 ≤7 天、将耗尽 ≥85%、已过期、已用完。筛选栏与状态 chip 共用这一处
  // 判定（阈值只此一份，避免筛选说『没问题』而 chip 亮黄的漂移）。
  const keyState = (k) => {
    const u = k.usage || {};
    const now = Date.now();
    const expired = k.expiresAt != null && k.expiresAt < now;
    const expDays = k.expiresAt != null ? Math.ceil((k.expiresAt - now) / 86400000) : null;
    const expiringSoon = !expired && expDays != null && expDays <= 7;
    const usedUp = (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= 1) || (u.quotaUsedPct != null && u.quotaUsedPct >= 1);
    const nearLimit = !usedUp && ((u.quotaUsedPct != null && u.quotaUsedPct >= .85) || (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= .85));
    return { expired, expDays, expiringSoon, usedUp, nearLimit, attention: !!k.enabled && (expired || expiringSoon || usedUp || nearLimit) };
  };

  // ov 页需关注 chip（manual#221）：落地页给 key 预警一个视觉信号——此前预警只在点开
  // 『一键值班摘要』后才取数计算（#162），ov 页常驻无信号。chip 点击直达 keys 页的
  // 『需关注』筛选（KEY_FILTER 预设）。keys 未取到（首屏瞬时/取数失败）时不显。
  const ovRiskChip = () => {
    if (!OV_KEYS_CACHE) return '';
    const risky = OV_KEYS_CACHE.filter((k) => keyState(k).attention);
    if (!risky.length) return '';
    return '<button class="bare" id="ov-risk" style="float:right;margin-left:10px;color:var(--warn,#c80)" title="' + esc(risky.map((k) => k.id + '（' + shortLabel(k.label, 30) + '）').join('&#10;')) + '">⚠ ' + risky.length + ' 个 key 需关注 →</button>';
  };
  function keyFilterBar(all) {
    const on = all.filter((k) => k.enabled).length;
    const off = all.length - on;
    const btn = (id, label, n) =>
      '<button data-kf="' + id + '"' + (KEY_FILTER === id ? ' class="on"' : '') + '>' + label + ' <span class="dim">' + n + '</span></button>';
    const risk = all.filter((k) => keyState(k).attention).length;
    return '<div class="row"><div class="filters">' +
      btn('on', '生效中', on) + btn('risk', '需关注', risk) + btn('off', '已停用', off) + btn('all', '全部', all.length) +
      '</div><span class="spacer" style="flex:1"></span>' +
      '<input id="k-q" placeholder="🔍 搜索 id / 备注 / 指纹" value="' + esc(KEY_Q) + '" style="width:210px"></div>';
  }

  function applyKeyFilter(all) {
    const q = KEY_Q.trim().toLowerCase();
    return all.filter((k) => {
      if (KEY_FILTER === 'on' && !k.enabled) return false;
      if (KEY_FILTER === 'risk' && !keyState(k).attention) return false;
      if (KEY_FILTER === 'off' && k.enabled) return false;
      if (!q) return true;
      return (String(k.id) + ' ' + String(k.label) + ' ' + String(k.hashPrefix)).toLowerCase().includes(q);
    });
  }

  async function vKeys() {
    // auth-policy 与 keys 并行取（manual#212）：档位策略表供 keyForm 显示所选档位的
    // 真实默认额度（placeholder 此前只有通用文案『留空=分层默认』——运营要凭记忆或翻
    // ops 页才知道 pro 是 500 万 token）。取失败不影响 keys 页其余部分。
    // slim overview 只为拿 clientAuthFailures（manual#256）：空台账时显窗口内落库计数；
    // 取失败不影响 keys 页其余部分（catch 兜底）。
    const [d, pol, ov] = await Promise.all([api('keys'), api('auth-policy').catch(() => ({ tiers: {} })),
      // slim+全局窗口（manual#318）：此前硬编码 24h——运营把窗口选择器切到 7d/30d 后，
      // 本页的『窗口内 N 次』仍是 24h 的数，口径与全站其他页不一致；改用 win() 与选择器
      // 对齐（slim 保留 summary.clientAuthFailures，不含 keys/events/topErrors 死重）。
      api('overview?window=' + win() + '&slim=1').catch(() => ({}))]);
    const all = d.keys || [];
    const keys = applyKeyFilter(all);
    const af = d.authFailures;
    $('main').innerHTML = \`
      <div class="note warn"><b>明文 key 只在创建/轮换时显示一次。</b>服务端只保存 sha256 哈希，无法再次查看——忘了就轮换。
        配置文件里的 key（来源=配置）只能禁用不能删除（删了重启还会回来）。</div>
      <section class="block"><h2>鉴权自检 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">"API 全 401"通常是 key 不对，不是服务挂了——贴一下就知道</span></h2>
        <div class="f"><label>粘贴你手上正在使用的 key</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="whoami-key" type="password" placeholder="sk-relay-..." style="flex:1">
            <button class="pri" id="whoami-go">自检</button>
          </div>
        </div>
        <div id="whoami-out"></div>
        \${authFailHtml(af, (ov && ov.summary || {}).clientAuthFailures)}
      </section>
      <section class="block"><h2>客户 Key <span class="spacer"></span>
        <button class="pri" id="k-new">+ 新建 Key</button>
        <button class="bare" id="k-csv" title="导出本周期全部 key 的用量 CSV（对账用；BOM+CRLF，Excel 直接打开）">导出 CSV</button>
        <button class="bare" id="k-json" title="导出本周期全部 key 的用量 JSON（备份/审阅用）">导出 JSON</button>
        <button class="bare" id="k-refresh">↻</button></h2>
        \${keyFilterBar(all)}
        <table id="k-table">
          \${renderKeyRows(keys)}
        </table>
      </section>\`;

    $('k-refresh').addEventListener('click', render);
    $('main').querySelectorAll('[data-kf]').forEach((b) => b.addEventListener('click', () => {
      KEY_FILTER = b.dataset.kf;
      try { localStorage.setItem('relay_admin_key_filter', KEY_FILTER); } catch { /* 存不上不影响当次 */ }
      render();
    }));
    // 重画表格行之后**必须重挂事件**：innerHTML 换掉的是新节点，旧监听器不会跟过来。
    // 曾经漏了这一步，于是"搜索之后行内按钮全部失效"（点了没反应）。
    const paintKeyRows = () => {
      const host = $('k-table'); // 必须按 id 命中：这一页还有一张"被拒 key 台账"表，用 section table 会打到它
      if (!host) return;
      const shown = applyKeyFilter(all);
      host.innerHTML = renderKeyRows(shown);
      bindKeyRowActions(shown);
    };
    const bindKeyRowActions = (shown) => {
      $('main').querySelectorAll('[data-act]').forEach((b) =>
        b.addEventListener('click', () => keyAction(b.dataset.act, b.dataset.id, shown.find((x) => x.id === b.dataset.id) || all.find((x) => x.id === b.dataset.id), pol)));
    };
    const kq = $('k-q');
    if (kq) {
      kq.value = KEY_Q;   // 恢复持久化的搜索词（manual#223）
      kq.addEventListener('input', () => {
        KEY_Q = kq.value;
        try { localStorage.setItem('relay_admin_key_q', KEY_Q); } catch { /* 存不上不影响当次 */ }
        paintKeyRows();
      });
    }
    // 导出用量 CSV（manual#93）：对账/月账是运营固定动作——B 站时代有 usage_report.py 干这事，
    // 合并站点 GUI 里key 数据已在页面里，客户端生成即可，零新 API。BOM 让 Excel 正确识别中文。
    // 本文件是外层 HTML 模板字面量：换行/BOM 一律用 String.fromCharCode 构造，不写反斜杠转义（#88/#91/#92 同坑）。
    $('k-csv').addEventListener('click', () => {
      const head = ['key', '备注', '分层', '来源', '状态', '本周期token', '请求数', '成本CNY', '额度token', '额度CNY', '过期时间'];
      const rows = [head];
      for (const k of all) {
        const u = k.usage || {};
        const expired = k.expiresAt && k.expiresAt < Date.now();
        rows.push([k.id, k.label || '', k.tier, k.origin === 'panel' ? '面板' : '配置',
          !k.enabled ? '已停用' : expired ? '已过期' : (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= 1) || (u.quotaUsedPct != null && u.quotaUsedPct >= 1) ? '已用完' : '生效中',
          u.tokens ?? 0, u.requests ?? 0, (u.costCny ?? 0).toFixed(4),
          u.quota ?? '', u.quotaCny ?? '', k.expiresAt ? TS(k.expiresAt) : '']);
      }
      const CRLF = String.fromCharCode(13, 10);
      const cell = (c) => {
        const s = String(c == null ? '' : c);
        const need = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf(String.fromCharCode(10)) >= 0 || s.indexOf(String.fromCharCode(13)) >= 0;
        return need ? '"' + s.split('"').join('""') + '"' : s;
      };
      const csv = String.fromCharCode(0xFEFF) + rows.map((r) => r.map(cell).join(',')).join(CRLF);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'api-relay-keys-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 ' + (rows.length - 1) + ' 个 key 的用量 CSV', 'g');
    });
    // P6 修复：导出 JSON
    $('k-json').addEventListener('click', () => {
      const data = all.map((k) => ({
        id: k.id,
        label: k.label,
        tier: k.tier,
        origin: k.origin,
        enabled: k.enabled,
        expiresAt: k.expiresAt,
        usage: k.usage,
      }));
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), keys: data }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'api-relay-keys-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 ' + data.length + ' 个 key 的 JSON', 'g');
    });
    $('k-new').addEventListener('click', () => keyForm(null, pol));
    // 回车自检（manual#210）：whoami 是粘贴-验证流程（运营粘贴客户的 key 核对），
    // 输入框按回车应直接触发自检——沿用 click 处理器（程序触发，零重复逻辑；
    // 不包装重赋值——#208 模板层教训）。
    $('whoami-key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('whoami-go').click(); }
    });
    $('whoami-go').addEventListener('click', async () => {
      const secret = $('whoami-key').value.trim();
      if (!secret) { toast('请先粘贴要自检的 key', 'y'); return; }
      const out = $('whoami-out');
      // 模型名缓存预热（manual#281）：下面的允许模型标记要用 MODEL_NAMES 判定『是否已声明』——
      // 缓存可能因没开过 keyForm 而空。并行等两者（manual#316，#315 依赖图模式）：刷新与
      // whoami 互不依赖，但渲染依赖两者的结果——并行且确定，不再有『降级看运气』的竞态。
      out.innerHTML = '<div class="dim" style="font-size:12px;margin-top:8px">核对中…</div>';
      try {
        const [, r] = await Promise.all([
          refreshModelNames(),
          api('keys/whoami', { method: 'POST', body: JSON.stringify({ secret }) }),
        ]);
        $('whoami-key').value = '';
        const st = r.status === 'ok' ? '<span class="chip g">有效</span>' :
          r.status === 'key_disabled' ? '<span class="chip">已禁用</span>' :
          r.status === 'expired_key' ? '<span class="chip y">已过期</span>' : '<span class="chip r">不是本网关签发的 key</span>';
        out.innerHTML = '<div class="note ' + (r.status === 'ok' ? '' : r.status === 'not_issued' ? 'bad' : 'warn') + '" style="margin-top:8px"><b>' + st + '</b>' +
          ' 指纹 <span class="mono">' + esc(r.fingerprint) + '</span>' +
          (r.key ? ' → <span class="mono">' + esc(r.key.id) + '</span>（' + esc(r.key.label) + ' · ' + esc(((pol && pol.tiers || {})[r.key.tier] || {}).label || r.key.tier) + '）' +
            // 档位策略摘要（manual#216）：whoami 是运营核对客户 key 的场景——只显裸档位 id
            // 不够，要看该档位的限流与额度（客户问『我为什么被限』时直接对照）。数据取自
            // r.key.policy（keys 视图已带）+档位中文名取 pol.tiers（#212 同源）。
            (r.key.policy ? '<div class="dim" style="font-size:11px;margin-top:2px">rpm ' + formatNumber(r.key.policy.rpm) + ' · 并发 ' + formatNumber(r.key.policy.maxConcurrency) +
              (r.key.policy.periodQuotaTokens != null ? ' · 额度 ' + formatNumber(r.key.policy.periodQuotaTokens) + ' token' : ' · 按量计费无周期额度') +
              (r.key.policy.periodQuotaCny != null ? ' · 预算 ' + cny(r.key.policy.periodQuotaCny) : '') + '</div>' : '') +
            // 允许模型（manual#254）：客户问『我能用哪些模型』时运营要能直接答——此前 whoami
            // 不显 allowedModels（KeyView 一直带，GUI 没消费）；空=全部（档位不限）。
            (r.key ? '<div class="dim" style="font-size:11px;margin-top:2px">允许模型：' +
              (r.key.allowedModels && r.key.allowedModels.length
                ? r.key.allowedModels.map((m) => (MODEL_NAMES.length && !MODEL_NAMES.includes(m))
                    ? '<span class="chip r" title="' + esc(m) + ' 不是网关已声明的模型——客户调用它会 404（model_not_found）；如非故意预配，去编辑修正">' + esc(m) + ' ⚠未声明</span>'
                    : esc(m)).join('、')
                : '全部（本网关已声明的均可调）') + '</div>' : '')
          : '') +
          '<br>' + esc(r.explanation || '') + '</div>';
      } catch (e) {
        // 走 writeErr 分类（manual#202）：空 secret 的 400 是输入问题（黄），不是系统故障（红）——
        // 与其余写动作同一套分类（#193）。
        out.innerHTML = '';
        const r = writeErr('自检', e);
        toast(r.text, r.tone);
      }
    });
    bindKeyRowActions(keys);
  }

  function keyForm(k, pol) {
    const isNew = !k;
    // 档位默认额度提示（manual#212）：placeholder 显示所选档位的真实默认值，切档位即时
    // 更新（f-tier 的 change 绑定在下方）。pol 缺失（auth-policy 取失败）回落通用文案。
    const quotaHint = () => {
      // 模板构造期 f-tier 尚未入 DOM（drawer 是拿到 html 后才 innerHTML）——此时回落
      // 到 key 自身档位或新建默认 standard；change 处理器触发时元素已在，取当前值。
      const el = $('f-tier');
      const tier = el ? el.value : (k ? k.tier : 'standard');
      const t = (pol && pol.tiers && pol.tiers[tier]) || null;
      if (!t || t.periodQuotaTokens == null) return '留空=分层默认';
      return '留空=分层默认（' + t.label + '：' + formatNumber(t.periodQuotaTokens) + ' token）';
    };
    drawer(isNew ? '新建客户 Key' : '编辑 Key ' + k.id, \`
      <div class="note">\${isNew ? '明文 key 只在创建后显示一次，服务端只保存 sha256。' : '这里改的是元数据；换 key 请用「轮换」（旧 key 会立即失效）。'}</div>
      <div class="f"><label>备注名</label><input id="f-label" maxlength="64" value="\${esc(k ? k.label : '')}" placeholder="例如：张三的 Dify 应用（≤64 字）"></div>
      <div class="f"><label>分层</label><select id="f-tier">
        \${['free', 'standard', 'pro'].map((t) => '<option value="' + t + '"' + ((k ? k.tier : 'standard') === t ? ' selected' : '') + '>' + t + (t === 'pro' ? '（降损全开）' : t === 'free' ? '（纯管道）' : '（按 token）') + '</option>').join('')}
      </select></div>
      \${isNew ? '<div class="f"><label>租户</label><input id="f-tenant" value="default"></div>' : ''}
      <div class="f"><label>允许模型</label><input id="f-models" list="f-models-list" value="\${esc(k && k.allowedModels ? k.allowedModels.join(', ') : '')}" placeholder="留空=全部；多个用逗号分隔（输入时从下方清单选，防打错）">
        <datalist id="f-models-list">\${MODEL_NAMES.map((m) => '<option value="' + esc(m) + '">').join('')}</datalist></div>
      <div class="f"><label>额度(token)</label><input id="f-quota" type="number" min="0" value="\${k && k.quotaOverride != null ? k.quotaOverride : ''}" placeholder="\${quotaHint()}"></div>
      <div class="f"><label>预算(元)</label><input id="f-quotacny" type="number" min="0" step="0.01" value="\${k && k.quotaCnyOverride != null ? k.quotaCnyOverride : ''}" placeholder="留空=不限。例如 10 = 最多花 ¥10"></div>
      \${isNew ? '<div class="f"><label>有效期(天)</label><input id="f-days" type="number" min="0" placeholder="留空=长期"></div>' : ''}
      \${!isNew && k && k.expiresAt ? (() => { const d = Math.ceil((k.expiresAt - Date.now()) / 86400000);
        return '<div class="f"><label>当前有效期至</label><div style="align-self:center">' + TS(k.expiresAt) +
        (d >= 0 ? ' <span class="' + (d <= 7 ? 'warn' : 'dim') + '">（还剩 ' + d + ' 天）</span>' : ' <span class="err">（已过期）</span>') + '</div></div>' +
        '<div class="f"><label>续期(天)</label><input id="f-extend" type="number" min="0" placeholder="留空=不变；从当前有效期起算"></div>';
      })() : ''}
    \`, '<button class="bare" id="f-cancel">取消</button><button class="pri" id="f-save">' + (isNew ? '创建' : '保存') + '</button>');

    // 表单内回车=保存（manual#328，#114 模式补全）：keyForm 无 form 包装，此前在
    // label/quota/tenant 等输入框按 Enter 只是挪焦点——运营填完习惯性回车却提交不了。
    // textarea/select 除外（Enter 在 textarea 里是换行、在 select 里是选项）。
    for (const fid of ['f-label', 'f-quota', 'f-quotacny', 'f-tenant', 'f-extend', 'f-days']) {
      const el = $(fid);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('f-save').click(); }
      });
    }
    // 切档位即时更新额度 placeholder（manual#212）
    $('f-tier').addEventListener('change', () => { $('f-quota').placeholder = quotaHint(); });
    // 模型名缓存预热+迟到填充（manual#262）：模板构造时缓存可能还没到（首次/过期），
    // 这里触发刷新；providers 返回后若表单还开着，把 datalist 补上。
    refreshModelNames();
    $('f-cancel').addEventListener('click', closeDrawer);
    $('f-save').addEventListener('click', async () => {
      const models = ($('f-models').value || '').split(',').map((s) => s.trim()).filter(Boolean);
      const quotaRaw = $('f-quota').value.trim();
      const quotaCnyRaw = $('f-quotacny').value.trim();
      try {
        if (isNew) {
          const days = Number($('f-days').value);
          const r = await api('keys/create', { method: 'POST', body: JSON.stringify({
            label: $('f-label').value, tier: $('f-tier').value, tenantId: $('f-tenant').value || 'default',
            ...(models.length ? { allowedModels: models } : {}),
            ...(quotaRaw ? { quotaOverride: Number(quotaRaw) } : {}),
            ...(quotaCnyRaw ? { quotaCny: Number(quotaCnyRaw) } : {}),
            ...(days > 0 ? { expiresInDays: days } : {}),
          }) });
          closeDrawer();
          secretDrawer('新 Key（' + r.key.tier + ' · ' + r.key.id + '）', r.secret, r.secretNotice, r.key);
          // 未声明模型警告（manual#263）：datalist 防打错（#262）之外的服务端 advisory——
          // 拼错的模型名静默入库后客户调它全 404，保存成功也要黄显提醒。
          if (r.unknownModels && r.unknownModels.length) {
            toast('注意：<b>' + esc(r.unknownModels.join('、')) + '</b> 不是网关已声明的模型——客户调用会 404，确认是故意为之（如预配）再保留', 'y');
          }
          render();
        } else {
          // 续期（manual#158）：从当前有效期起算（已过期的从此刻起算）——编辑态看不到当前
          // 有效期就没法续（#153 预警说『3 天后过期』，运营点编辑却看不到是哪天）。
          const extRaw = ($('f-extend') ? $('f-extend').value : '').trim();
          const extDays = extRaw === '' ? null : Number(extRaw);
          if (extDays !== null && (!Number.isFinite(extDays) || extDays < 0)) return toast('续期天数必须为 ≥0 的数字', 'r');
          // 单次写入（manual#388 修双写）：此前同一载荷连发两次（首次结果丢弃、二次
          // 捕获为 ur）——幂等所以不坏数据，但每次编辑双 DB 写+双 key.update 审计事件
          // （取证时看起来像改了两次），且写操作哪天变非幂等即成真 bug。留一次拿结果。
          const ur = await api('keys/update', { method: 'POST', body: JSON.stringify({
            keyId: k.id, label: $('f-label').value, tier: $('f-tier').value,
            allowedModels: models.length ? models : null,
            ...(extDays !== null && extDays > 0 ? { expiresAt: Math.max(Date.now(), k.expiresAt || 0) + extDays * 86400000 } : {}),
            quotaOverride: quotaRaw === '' ? null : Number(quotaRaw),
            quotaCny: quotaCnyRaw === '' ? null : Number(quotaCnyRaw),
          }) });
          closeDrawer(); toast('已保存 <b>' + esc(k.id) + '</b>', 'g');
          // 未声明模型警告（manual#263）：同 create——白名单更新里的拼错模型名黄显提醒。
          if (ur.unknownModels && ur.unknownModels.length) {
            toast('注意：<b>' + esc(ur.unknownModels.join('、')) + '</b> 不是网关已声明的模型——客户调用会 404，确认是故意为之（如预配）再保留', 'y');
          }
          render();
        }
      } catch (e) { const r = writeErr('保存 Key', e); toast(r.text, r.tone); }
    });
  }

  /* 客户接入包（manual#368）：新客户接入时运营原本要拼五样东西（端点表/错误码/
   * SDK 示例/自验命令/这把 key 的模型白名单）——而「创建 key 成功」这一刻它们全都
   * 在手边。一键组装成可直接转发客户的 markdown。公网地址是运营事实（Tailscale
   * Funnel）不在 config 里——迁移时改这一处。
   * 实现注记：全文零反斜杠——curl 的单引号用 Q 拼、JSON 用双引号（JS 单引号串里
   * 免转义），杜绝 Python→JS 双层转义把引号吃掉的故障模式（#397 首版就是这么崩的）。
   */
  const PUBLIC_BASE = 'https://api-relay.tail62168c.ts.net';
  const Q = String.fromCharCode(39);

  function customerPackage(secret, key) {
    const base = PUBLIC_BASE + '/v1';
    const models = (key && key.allowedModels && key.allowedModels.length)
      ? '你这把 key 可用的模型：' + key.allowedModels.map((m) => '. ' + m).join('；')
      : '全部可用模型（不带白名单）——调用 GET ' + base + '/models 会返回你这把 key 能用的清单';
    // 示例模型从白名单取第一个（manual#401 修 #397 交付物的真 bug）：SDK 示例与自验
    // curl 此前硬编码 mimo-v2.6-flash——白名单不含它的 key（如 agnes 专卖）客户第一步
    // 复制粘贴就 403 model_not_allowed。接入包的每个示例都必须落在这把 key 能用集里。
    const exampleModel = (key && key.allowedModels && key.allowedModels.length)
      ? key.allowedModels[0]
      : 'mimo-v2.6-flash';
    const tier = (key && key.tier) || 'standard';
    const nl = String.fromCharCode(10);

    const py = [
      'from openai import OpenAI', '', 'client = OpenAI(',
      '    base_url="' + base + '",', '    api_key="' + secret + '",', ')', '',
      'resp = client.chat.completions.create(',
      '    model="' + exampleModel + '",',
      '    messages=[{"role": "user", "content": "你好"}],',
      '    max_tokens=512,  # 推理模型请给足：小额 max_tokens 可能只返回推理、可见内容为空',
      ')', 'print(resp.choices[0].message.content)',
    ].join(nl);

    const sh = [
      'curl -s -D - -H ' + Q + 'authorization: Bearer ' + secret + Q
      + ' -H ' + Q + 'content-type: application/json' + Q
      + ' -d ' + Q + '{"model":"' + exampleModel + '","messages":[{"role":"user","content":"你好"}],"max_tokens":256}' + Q
      + ' ' + base + '/chat/completions',
    ].join(nl);

    return [
      '# API 接入信息（api-relay 网关）', '',
      '- Base URL: ' + base, '- API Key: ' + secret, '- ' + models, '',
      '## 快速开始（Python，OpenAI SDK 只改两行）', '', '~~~python', py, '~~~', '',
      '## 可用端点', '',
      '- POST ' + base + '/chat/completions — OpenAI 兼容对话（支持 "stream": true 流式）',
      '- POST ' + base + '/completions — 旧版文本补全（传 prompt）',
      '- GET ' + base + '/models — 你这把 key 可用的模型清单',
      '- POST ' + base + '/messages 与 ' + base + '/responses — Anthropic / OpenAI Responses 兼容（messages 仅 agnes 系模型，详见运营提供的完整文档）', '',
      '## 常见错误（错误体形状 { error: { message, type, code } }）', '',
      '- 401: missing_key（没带 Authorization 头）/ invalid_key（key 无效）/ key_disabled（已停用）/ expired_key（已过期）',
      '- 403: model_not_allowed（该模型不在这把 key 的白名单里，message 会列出可用模型）',
      '- 404: model_not_found（模型名不存在，先用 GET /models 核对）',
      '- 429: rate_limited（每分钟请求数超限）/ too_many_concurrent（并发超限）/ quota_exhausted（本周期额度用完）——按 error.relay_attribution.suggested_next.retryAfterMs 退避后重试，或控制请求频率；网关对 429 是立即拒绝，不占用额度',
      '- 502/503: upstream_error（上游故障）——可重试；建议客户端超时 >=120s（推理模型首字节可能较慢），或改用流式', '',
      '## 自验（应返回 200 与模型回复）', '', '~~~bash', sh, '~~~', '',
      '用量与额度查询：GET ' + base + '/quota（本机默认放开；需要远程访问请联系运营）。',
      '当前档位：' + tier + '（速率/并发上限见 429 错误的 message，或联系运营）。',
      '完整文档（端点表/错误码全表/流式说明）由运营提供。',
    ].join(nl);
  }

  function secretDrawer(title, secret, notice, key) {
    drawer(title, '<div class="note warn"><b>只显示这一次。</b>' + esc(notice || '服务端只保存哈希，关闭后无法再次查看。') + '</div><div class="secret" id="sec">' + esc(secret) + '</div>',
      '<button class="bare" id="sec-pack" title="组装一份可直接转发客户的 markdown：地址+key+可用模型+SDK 示例+端点+常见错误+自验命令">复制客户接入包</button><button class="bare" id="sec-copy">复制</button><button class="pri" id="sec-ok">我已保存</button>');
    $('sec-ok').addEventListener('click', closeDrawer);
    $('sec-copy').addEventListener('click', () => copyText($('sec').textContent));
    $('sec-pack').addEventListener('click', () => copyText(customerPackage(secret, key), '客户接入包已复制——直接转发客户即可上手（含地址/key/模型清单/SDK 示例/错误码/自验命令）'));
  }

  async function keyAction(act, id, row, pol) {
    try {
      if (act === 'edit') return keyForm(row, pol);
      if (act === 'more') {
        // 不可逆的动作集中到这里，并把后果写在按钮前面 —— 而不是让它挂在每一行等人误点
        const on = !!(row && row.enabled);
        drawer('管理 ' + esc(id),
          '<div class="note warn"><b>这两个动作都不可撤销。</b><br>' +
          '「轮换」会让旧 key <b>立即失效</b>，正在用它的客户端马上开始 401；<br>' +
          '「' + (on ? '停用' : '启用') + '」' + (on ? '会让该 key 立刻无法调用（历史度量保留）。' : '会让该 key 重新可用。') + '</div>' +
          '<div class="row"><button class="pri" id="m-rotate" style="width:100%">轮换 key（生成新明文，旧的立即作废）</button></div>' +
          '<div class="row"><button class="' + (on ? 'danger' : '') + '" id="m-toggle" style="width:100%">' + (on ? '停用这个 key' : '重新启用这个 key') + '</button></div>',
          // 删除（manual#306）：deletable 字段（panel 来源）此前面临「有标记无入口」——能力层
          // remove() 与字段都在，admin 层没注册端点。配置来的 key 不显示（删了重启会回来）。
          (row && row.deletable ? '<div class="row"><button class="danger" id="m-delete" style="width:100%">彻底删除这个 key（度量与审计事件保留）</button></div>' : '') +
          '<button class="bare" id="m-close">关闭</button>');
        $('m-close').addEventListener('click', closeDrawer);
        $('m-rotate').addEventListener('click', () => { closeDrawer(); keyAction('rotate', id, row); });
        $('m-toggle').addEventListener('click', () => { closeDrawer(); keyAction(on ? 'disable' : 'enable', id, row); });
        if ($('m-delete')) $('m-delete').addEventListener('click', () => { closeDrawer(); keyAction('delete', id, row); });
        return;
      }
      if (act === 'rotate') {
        if (!confirm('轮换 ' + id + ' 的 key？旧 key 会立即失效，正在使用它的客户端会中断。')) return;
        const r = await api('keys/rotate', { method: 'POST', body: JSON.stringify({ keyId: id }) });
        secretDrawer('新 Key（轮换 ' + id + '）', r.secret, r.secretNotice, r.record || r.key); render();
      } else if (act === 'reset') {
        if (!confirm('重置 ' + id + ' 的本周期额度？历史度量保留，但额度从此刻重新起算。')) return;
        const r = await api('keys/reset-quota', { method: 'POST', body: JSON.stringify({ keyId: id }) });
        toast('已重置 <b>' + esc(id) + '</b>：原用量 ' + formatNumber(r.before) + ' token → 归零', 'g'); render();
      } else if (act === 'disable') {
        // 可逆停用（manual#365）：走 update{enabled:false} 而非 revoke——revoke 对 panel key
        // 会摘除 byHash/dynamic 索引，而 findRecord 只搜 byHash：停用后到下次重启前该 key
        // 管理面全 404（列表消失、无法重新启用、无法彻底删除），重启后才以停用态复活
        // （restore 不过滤 enabled）。update 停用：auth 同样 401 key_disabled、key 留在
        // 列表可随时启用、重启后仍是停用态——『停用』字面如实质。revoke 端点保留给脚本用。
        if (!confirm('停用 ' + id + '？该 key 将立即无法调用（401 key_disabled），可随时重新启用。')) return;
        await api('keys/update', { method: 'POST', body: JSON.stringify({ keyId: id, enabled: false }) });
        toast('已停用 <b>' + esc(id) + '</b>（可重新启用）', 'y'); render();
      } else if (act === 'enable') {
        await api('keys/update', { method: 'POST', body: JSON.stringify({ keyId: id, enabled: true }) });
        toast('已启用 <b>' + esc(id) + '</b>', 'g'); render();
      } else if (act === 'delete') {
        // 彻底删除（manual#306）：仅 panel 来源（服务端再拒一道 config key）。二次确认+明文后果。
        if (!confirm('彻底删除 ' + id + '？该 key 的凭证将立即失效且无法恢复（历史度量与审计事件保留）；配置里来的 key 不会被彻底删除——请改用停用。')) return;
        const r = await api('keys/delete', { method: 'POST', body: JSON.stringify({ keyId: id }) });
        toast('已彻底删除 <b>' + esc(id) + '</b>', 'r'); render();
      }
    } catch (e) { const r = writeErr('Key 操作', e); toast(r.text, r.tone); }
  }

  /* ============ 上游 ============ */
  async function vCh() {
    // 并行取 overview（manual#133）：本页是动作页（摘除/清熔断），但进程累计的失败/总数回答不了
    // 「这个上游现在还在失败吗」——窗口错误率才是决策信号，此前要交叉翻 ov 页。
    // 与 ov 的按上游区块同口径（>20% err / >5% warn），两个页面一个色标。
    // overview 软降级（manual#191）：providers 是本页主页内容，ov2 只补窗口错误率——
    // 它失败时表格照显（错误率列显 -），不该整页白屏。
    const [d, ov2] = await Promise.all([api('providers'), api('overview?window=' + win() + '&slim=1').catch(() => ({ summary: {} }))]);  // slim（manual#298）：排障页只用 summary——非 slim 会多带 keys(25.8KB)/events/topErrors 死重
    const winRate = {};
    for (const bp of ((ov2.summary || {}).byProvider) || []) winRate[bp.key] = bp;
    const list = d.providers || [];
    $('main').innerHTML = \`
      <div class="note">上游故障时：<b>摘除</b>会立刻把流量切走（不重启）；<b>清熔断</b>只重置失败计数，不改变启用状态。
        所有操作都会记入「信任」页之外的运维事件流（配置页可见）。</div>
      <section class="block"><h2>上游渠道 <span class="spacer"></span><button class="bare" id="p-refresh">↻</button></h2>
        <table>
          <tr><th>上游</th><th>状态</th><th>模型</th><th>Key</th><th class="num">并发</th><th class="num">延迟</th><th class="num">失败/总</th><th class="num">窗口错误率</th><th class="act">操作</th></tr>
          \${list.map((p) => {
            const wr = winRate[p.id];
            // 这个接口（/admin/api/providers）返回的是**嵌套**结构：状态都在 p.health 里。
            // 以前这里读了扁平字段（p.breakerOpen / p.ewmaLatencyMs / p.totalFailures…），
            // 于是延迟列显示 "-ms"、"失败/总"显示 "undefined/undefined"、**"熔断中"永远不亮** ——
            // 恰恰是运维最需要看出来的那一个状态。
            const breakerOpen = (p.health.openUntil || 0) > Date.now();
            const st = p.disabled ? '<span class="chip">已摘除</span>' : breakerOpen ? '<span class="chip r">熔断中</span>' : p.health.healthy ? '<span class="chip g">正常</span>' : '<span class="chip y">异常</span>';
            const keyCell = p.keyPool
              ? '<span class="chip' + (p.keyPool.filter((k) => !k.dead && k.cooldownMsLeft <= 0).length ? '' : ' r') + '" title="' + esc(p.keyPool.map((k) => '#' + k.index + ' ' + k.masked + (k.dead ? '（报废）' : k.cooldownMsLeft > 0 ? '（冷却 ' + Math.round(k.cooldownMsLeft / 1000) + 's）' : '')).join('\\n')) + '">' +
                p.keyPool.filter((k) => !k.dead && k.cooldownMsLeft <= 0).length + '/' + p.keyPool.length + ' 可用</span>'
              : '<span class="mono">' + esc(p.apiKeyMasked) + '</span>';
            return '<tr class="click" data-p="' + esc(p.id) + '"><td class="mono">' + esc(p.id) + '</td><td>' + st + '</td>' +
              '<td class="dim" style="font-size:12px">' + esc((p.models || []).join(', ').slice(0, 54)) + '</td><td>' + keyCell + '</td>' +
              '<td class="mono num">' + p.concurrency.active + '/' + p.concurrency.limit + (p.concurrency.waiting ? ' +' + p.concurrency.waiting : '') + '</td>' +
              '<td class="mono num">' + (p.health.ewmaLatencyMs ? Math.round(p.health.ewmaLatencyMs) : '-') + 'ms</td>' +
              '<td class="mono num">' + (p.health.totalFailures || 0) + '/' + (p.health.totalRequests || 0) + '</td>' +
              '<td class="mono num">' + (wr
                ? '<span class="' + rateCls(wr.errorRate) + '" title="窗口内 ' + wr.requests + ' 次请求失败 ' + wr.errors + ' 次（与总览页按上游区块同口径）">' + pct(wr.errorRate) + '（' + wr.requests + '）</span>'
                : '<span class="dim" title="窗口内无请求">-</span>') + '</td>' +
              '<td class="act"><button class="bare" data-act="toggle" data-id="' + esc(p.id) + '" data-dis="' + (!p.disabled) + '">' + (p.disabled ? '恢复启用' : '摘除') + '</button>' +
              '<button class="bare" data-act="reset" data-id="' + esc(p.id) + '">清熔断</button></td></tr>';
          }).join('')}
        </table>
      </section>
      <section class="block"><h2>模型 × 上游可达性 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">右侧为空的模型当前不可用；「复制命令」给可直接执行的调用（manual#83）</span></h2>
        <table><tr><th>模型（客户端可用名）</th><th>可服务上游</th><th>工具调用</th><th class="act">调用</th></tr>
        \${(d.reachability || []).map((r) => '<tr><td class="mono">' + esc(r.model) + '</td><td>' + (r.providers.length ? r.providers.map((x) => '<span class="chip b">' + esc(x) + '</span>').join(' ') : '<span class="chip r">不可达</span>') + '</td><td>' + (r.tools ? '<span class="chip g" title="该模型声明支持 tool/function calling（配置 modelCapabilities）">支持</span>' : '<span class="dim" title="未声明工具能力——带 tools 的请求切过去可能失败">—</span>') + '</td><td class="act"><button class="bare" data-copy="' + esc(r.model) + '">复制命令</button></td></tr>').join('')}
        </table>
      </section>\`;

    $('p-refresh').addEventListener('click', render);
    // 复制调用命令绑定（manual#83）：innerHTML 换过之后旧监听器不跟过来，必须重挂（同 keyAction 的教训）
    $('main').querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => copyText(curlFor(b.dataset.copy),
        '命令已复制——把 <你的key> 换成「客户 Key」页签里的真实 key 即可调用')));
    $('main').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = b.dataset.id;
      try {
        if (b.dataset.act === 'toggle') {
          const dis = b.dataset.dis === 'true';
          // 摘除确认（manual#134）：一点就把上游撤出轮换、流量立即切换——key 三动作
          // （停用/轮换/重置额度）都有确认，摘除此前是秒执行。可恢复（恢复启用按钮），
          // 但代价是即时流量切换，确认框说清楚。清熔断无确认——它只清计数不改变状态。
          if (!confirm((dis ? '摘除' : '恢复启用') + '上游 <b>' + id + '</b>？' +
            (dis ? '流量将立即切到其他上游；仅剩一个上游时请求会直接失败。' : '') +
            + String.fromCharCode(10, 10) + '注意：人工摘除/恢复只对当前运行生效——重启网关后恢复 relay-net.yaml 里的启用态'
            + '（熔断状态相反，会跨重启保持）。要永久下线请改配置。')) return;
          await api('providers/toggle', { method: 'POST', body: JSON.stringify({ id, disabled: dis }) });
          toast('上游 <b>' + esc(id) + '</b> ' + (dis ? '已摘除，流量将切到其他上游' : '已恢复启用'), dis ? 'y' : 'g');
        } else {
          await api('providers/reset', { method: 'POST', body: JSON.stringify({ id }) });
          toast('已清除 <b>' + esc(id) + '</b> 的熔断计数', 'g');
        }
        render();
      } catch (e) { toast('操作失败：' + esc(e.message), 'r'); }
    }));
    $('main').querySelectorAll('tr[data-p]').forEach((tr) => tr.addEventListener('click', () => {
      const p = list.find((x) => x.id === tr.dataset.p);
      drawer('上游详情 · ' + esc(p.id), '<div class="kv">' +
        kv('标识', p.id) + kv('名称', p.label) + kv('协议', p.protocol) + kv('baseUrl', p.baseUrl) +
        kv('模型数', (p.models || []).length) + kv('标签', (p.tags || []).join(', ') || '-') +
        kv('优先级 / 权重', p.priority + ' / ' + p.weight) +
        kv('实付成本', p.cost ? ('输入 ¥' + p.cost.inputPerMTok + ' / 输出 ¥' + p.cost.outputPerMTok + ' / 缓存 ¥' + (p.cost.cachedInputPerMTok ?? p.cost.inputPerMTok) + ' 每百万') : '未配置（smart routing 会跳过它）') +
        kv('刊例价', p.listCost ? ('输入 ¥' + p.listCost.inputPerMTok + ' / 输出 ¥' + p.listCost.outputPerMTok + ' / 缓存 ¥' + (p.listCost.cachedInputPerMTok ?? p.listCost.inputPerMTok)) : '-') +
        (p.modelCosts ? kv('按型号实付', Object.entries(p.modelCosts).map(([m, c]) => m + ' → ¥' + c.inputPerMTok + '/¥' + c.outputPerMTok).join('；')) : '') +
        (p.modelListCosts ? kv('按型号刊例', Object.entries(p.modelListCosts).map(([m, c]) => m + ' → ¥' + c.inputPerMTok + '/¥' + c.outputPerMTok).join('；')) : '') +
        kv('HTTP/2', p.http2 ? '是' : '否') +
        // 「健康」与「熔断剩余」必须同源（r10 修复）：此前这里读 p.health.healthy，
        // 而列表视图读 openUntil——两者一旦不一致，详情页会显示「健康: 正常」紧挨着
        // 「熔断剩余: 29分」。现在统一按 openUntil 推导，与列表视图同一判据。
        kv('健康', (p.health.openUntil || 0) > Date.now() ? '熔断中' : p.health.healthy ? '正常' : '异常') + kv('连续失败', p.health.consecutiveFailures) +
        kv('熔断剩余', p.health.openUntil > Date.now() ? ms(p.health.openUntil - Date.now()) : '未熔断') +
        kv('最近失败原因', p.health.lastFailureReason || '-') +
        kv('ewma 延迟', ms(p.health.ewmaLatencyMs)) +
        kv('累计 失败/总', (p.health.totalFailures || 0) + ' / ' + (p.health.totalRequests || 0)) +
        '</div>' + (p.keyPool ? '<h2 style="margin-top:16px">Key 池</h2><table><tr><th>#</th><th>Key</th><th>状态</th><th>冷却</th><th>失败</th></tr>' +
          p.keyPool.map((k) => '<tr><td class="mono">' + k.index + '</td><td class="mono">' + esc(k.masked) + '</td><td>' + (k.dead ? '<span class="chip r">报废</span>' : k.cooldownMsLeft > 0 ? '<span class="chip y">冷却</span>' : '<span class="chip g">可用</span>') + '</td><td class="mono">' + (k.cooldownMsLeft > 0 ? Math.round(k.cooldownMsLeft / 1000) + 's' : '-') + '</td><td class="mono">' + k.failures + '</td></tr>').join('') + '</table>' : ''));
    }));
  }
  const kv = (k, v) => '<div class="k">' + esc(k) + '</div><div class="mono">' + esc(v) + '</div>';

  /* ============ 请求账本（原"轨迹"） ============ */
  let LEDGER = [];
  let LEDGER_FILTER = 'all';
  let LEDGER_TIME = 'all';   // 账本时间范围预设（manual#155）
  let LEDGER_Q = '';
  // 排障页事件 kind 前缀过滤（manual#109）；持久化（manual#223）：视角状态也是用户资产
  // （#205 线程的筛选器部分）——运营盯着某类事件刷新，筛选不再丢。
  let EV_FILTER = 'all';
  try { const _ev = localStorage.getItem('relay_admin_ev_filter'); if (_ev) EV_FILTER = _ev; } catch { /* 隐私模式忽略 */ }
  // 事件级别过滤（manual#314）：排障第一诉求『只看 error』——kind 前缀过滤管不了级别，
  // error 级事件混在 warn/info 里要人眼翻。与 kind 同款持久化；all=不按级别过滤。
  let EV_LEVEL = 'all';
  try { const _el = localStorage.getItem('relay_admin_ev_level'); if (_el) EV_LEVEL = _el; } catch { /* 隐私模式忽略 */ }
  const evLevelQuery = () => (EV_LEVEL === 'all' ? '' : '&level=' + encodeURIComponent(EV_LEVEL));

  // 账本行渲染（筛选/搜索时只重画表格，输入框不失焦——同 renderKeyRows 的教训）
  const renderLedgerRows = (rows) =>
    // 模型列（manual#228）：#227 起 slim 载荷带 model（route step 提取）——深搜能按模型搜，
    // 行内也要看得见（哪个请求用了哪个模型一眼可扫，不用点开抽屉）。
    '<tr><th>时间</th><th>request / trace</th><th>模型</th><th>结果</th><th class="num">耗时</th><th>失败阶段</th><th>步骤</th></tr>' +
    (rows.length ? rows.map((t) => '<tr class="click" data-t="' + esc(t.traceId) + '"><td class="mono">' + dayTime(t.startedAt) + '</td>' +
      '<td class="mono">' + esc(t.requestId) + '</td>' +
      '<td><span class="chip ' + (t.outcome === 'success' ? 'g' : t.outcome === 'aborted' ? 'y' : 'r') + '">' + esc(t.outcome) + '</span>' + (t.degraded ? ' <span class="chip y" title="预检内部异常→fail-open 放行（manual#102 错题本待查项）">降级</span>' : '') + '</td>' +
      '<td class="mono dim" style="max-width:150px;overflow:hidden;text-overflow:ellipsis" title="' + esc(t.model || '') + '">' + esc(t.model || '—') + '</td>' +
      '<td class="mono">' + ms(t.durationMs) + '</td><td class="mono dim">' + esc(t.failedAtStage || (t.degraded ? 'precheck(degraded)' : '-')) + '</td>' +
      '<td class="mono dim">' + formatNumber(t.stepCount == null ? 0 : t.stepCount) + '</td></tr>').join('')
      : '<tr><td colspan="7" class="dim">' + (LEDGER_Q.trim()
          ? '没有匹配「' + esc(LEDGER_Q.trim()) + '」的请求——换个关键词，或清空搜索框'
          : LEDGER_TIME !== 'all'
            ? '这个时间范围内没有记录（已加载 100 条约覆盖数小时）——放宽时间范围，或点右上角 ↻ 刷新'
            : '暂无记录；先发几个请求') + '</td></tr>');

  // 账本筛选 + 搜索（manual#84）：页面一直教"用户报障时让他给 x-request-id，在这里点开定位"，
  // 却没有搜索入口——运营拿到 id 要在 100 行里人肉滚动。本函数把这条承诺闭合。
  const LEDGER_RANGES = { '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000 };
  const ledgerMatch = (t) => {
    // 时间范围（manual#155）：与结果筛选是 AND 关系。运营的高频问法「刚才那一小时有谁的请求失败了」
    // 此前只能在 100 行里人肉扫时间列。已加载 100 条约覆盖数小时，24h 预设受此限（更早用深搜）。
    if (LEDGER_TIME !== 'all' && t.startedAt < Date.now() - LEDGER_RANGES[LEDGER_TIME]) return false;
    if (LEDGER_FILTER === 'degraded' && !t.degraded) return false;
    if (LEDGER_FILTER !== 'all' && LEDGER_FILTER !== 'degraded' && t.outcome !== LEDGER_FILTER) return false;
    const q = LEDGER_Q.trim().toLowerCase();
    if (!q) return true;
    // model 入本地筛选（manual#227）：slim 载荷带 model 字段（服务端从 route step 的 summary
    // 提取）后，本地 100 条的过滤也能按模型——与服务端深搜同字段。
    return [t.requestId, t.traceId, t.failedAtStage, t.outcome, t.model || ''].join(' ').toLowerCase().includes(q);
  };

  async function vLedger() {
    // slim=1（manual#163）：列表只取摘要字段（服务端预计算 degraded/stepCount）——
    // 全量 100 条 235KB vs slim 25KB；steps 详情在点开抽屉时按 id 单取（showTrace）。
    const d = await api('traces?limit=100&slim=1');
    LEDGER = d.traces || [];
    const status = (t) => t.outcome;
    const isDegraded = (t) => !!t.degraded;
    const counts = { all: LEDGER.length, degraded: 0 };
    for (const t of LEDGER) { counts[status(t)] = (counts[status(t)] || 0) + 1; if (isDegraded(t)) counts.degraded++; }

    $('main').innerHTML = \`
      <div class="note">一次请求内部的完整步骤：鉴权 → 预检 → 指纹 → 路由 → 上游 → 归因 → 重试 → 流 → 度量。
         用户报障时让他给响应头 <span class="mono">x-request-id</span>，在这里点开即可定位卡在哪一步。
         成功响应的字节可被客户端用 <span class="mono">x-relay-content-hmac</span> 自证未被改写（见「信任」页）。</div>
      <section class="block"><h2>请求账本 <span class="spacer"></span><button class="bare" id="l-csv" title="导出当前筛选结果的 CSV（异步事故分享用：贴进工单/群的文件；BOM+CRLF，Excel 直接打开）">导出 CSV</button><button class="bare" id="l-json" title="导出当前筛选结果的 JSON（备份/审阅用）">导出 JSON</button><button class="bare" id="l-refresh">↻</button></h2>
        <div class="row filters">
          \${['all', 'success', 'upstream_error', 'client_error', 'aborted', 'degraded'].map((f) =>
            '<button class="bare' + (LEDGER_FILTER === f ? ' on' : '') + '" data-f="' + f + '">' +
            ({ all: '全部', success: '成功', upstream_error: '上游错误', client_error: '客户端错误', aborted: '中断', degraded: '降级放行' }[f]) +
            ' · ' + formatNumber(counts[f] || 0) + '</button>').join('')}
        </div>
        <div class="row filters" style="margin-top:6px">
          <span class="dim" style="font-size:12px;align-self:center">时间：</span>
          \${[['all', '全部时间'], ['1h', '最近 1 小时'], ['6h', '最近 6 小时'], ['24h', '最近 24 小时']].map(([v, label]) =>
            '<button class="bare' + (LEDGER_TIME === v ? ' on' : '') + '" data-tr="' + v + '" title="按请求发起时间过滤已加载的 100 条；更早的记录用「深搜」">' + label + '</button>').join('')}
        </div>
        <div class="row" style="margin-top:8px">
          <input id="l-q" placeholder="🔍 搜索 request-id / trace-id / 模型 / 失败阶段（客户报障时粘贴他给的 id，回车唯一命中直接打开）" value="\${esc(LEDGER_Q)}" style="flex:1">
          <button class="bare" id="l-deep" title="深度搜索：在最近 5000 条里按同一字段过滤（本地 100 条零命中按回车也会自动触发）">深搜</button>
          <span id="l-count" class="dim" style="font-size:12px">\${formatNumber(LEDGER.filter(ledgerMatch).length)} / \${formatNumber(LEDGER.length)}</span>
        </div>
        <table id="l-table">\${renderLedgerRows(LEDGER.filter(ledgerMatch))}</table>
      </section>\`;

    const bindRows = () => $('l-table').querySelectorAll('tr[data-t]').forEach((tr) => tr.addEventListener('click', () => showTrace(tr.dataset.t)));
    const paint = () => {
      const host = $('l-table');
      if (!host) return;
      const rows = LEDGER.filter(ledgerMatch);
      host.innerHTML = renderLedgerRows(rows);
      bindRows();
      const cnt = $('l-count');
      if (cnt) cnt.textContent = formatNumber(rows.length) + ' / ' + formatNumber(LEDGER.length);
    };

    // 深度搜索（manual#92）：本地（已加载 100 条）0 命中时回退服务端——客户报障引用的 request-id
    // 常常早于当前加载窗口。fail-open：失败只 toast 不阻断；结果替换当前集并把筛选态复位为「全部」。
    const deepSearch = async (text) => {
      if (!text) return;
      try {
        // 深度搜索窗口 500→5000（manual#103）：trace 表已 5527 条/10 天，500 条约只覆盖 1 天——
        // 客户报障引用的 request-id 常是几天前的，搜不到就等于没有。代价：服务端全表扫描
        // 0.2~1.5s（刻意搜索动作可接受）；响应只含命中项（bandwidth 与窗口无关）。
        // 表再涨（月级 16k+）需时间范围过滤——那要服务端改 API，属能力层，先记账。
        const d = await api('traces?limit=5000&q=' + encodeURIComponent(text) + '&slim=1');
        const hits = d.traces || [];
        // 窗口文案用 scanned 真值（manual#279）：#103 把窗口 500→5000 后 toast 仍写『500 条』
        // （文案没跟）；空搜文案还把『已加载 100』与『深搜窗口』两个窗口混成一句。scanned 是
        // #278 统一后的筛选前口径=本次搜索的真实窗口，两条文案都按它说。
        const win = formatNumber(d.scanned || 0);
        if (!hits.length) { toast('最近 ' + win + ' 条内均无匹配「' + esc(text) + '」——更早的记录已被窗口截断，换关键词或缩小时间范围', 'y'); return; }
        LEDGER = hits;
        LEDGER_FILTER = 'all';
        $('main').querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === 'all'));
        paint();
        const cnt = $('l-count');
        if (cnt) cnt.textContent = '深度命中 ' + formatNumber(hits.length);
        toast('深度搜索命中 ' + hits.length + ' 条（最近 ' + win + ' 条，点 ↻ 恢复全量）', 'g');
      } catch (e) { toast('深度搜索失败：' + esc(e.message), 'r'); }
    };

    // 导出 CSV（manual#176）：导出当前筛选后的行（与表格同源）——异步事故分享（贴工单/群）
    // 的直接载体；列与表格一致（时间/request/trace/结果/耗时/失败阶段/步数/降级）。
    const lcsv = $('l-csv');
    if (lcsv) lcsv.addEventListener('click', () => {
      const CRLF = String.fromCharCode(13, 10);
      const cell = (c) => {
        const s = String(c == null ? '' : c);
        const need = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf(String.fromCharCode(10)) >= 0 || s.indexOf(String.fromCharCode(13)) >= 0;
        return need ? '"' + s.split('"').join('""') + '"' : s;
      };
      const head = ['时间', 'request', 'trace', '结果', '耗时ms', '失败阶段', '步数', '降级'];
      const visible = LEDGER.filter(ledgerMatch);
      const rows = [head].concat(visible.map((t) => [
        TS(t.startedAt), t.requestId, t.traceId, t.outcome, t.durationMs,
        t.failedAtStage || (t.degraded ? 'precheck(degraded)' : ''), t.stepCount == null ? 0 : t.stepCount, t.degraded ? '是' : '']));
      const csv = String.fromCharCode(0xFEFF) + rows.map((r) => r.map(cell).join(',')).join(CRLF);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'api-relay-traces-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 <b>' + visible.length + '</b> 条账本记录（当前筛选结果）', 'g');
    });
    // P6 修复：导出 JSON
    const ljson = $('l-json');
    if (ljson) ljson.addEventListener('click', () => {
      const visible = LEDGER.filter(ledgerMatch);
      const data = visible.map((t) => ({
        startedAt: t.startedAt,
        requestId: t.requestId,
        traceId: t.traceId,
        outcome: t.outcome,
        durationMs: t.durationMs,
        failedAtStage: t.failedAtStage,
        stepCount: t.stepCount,
        degraded: t.degraded,
      }));
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), traces: data }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'api-relay-traces-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 <b>' + data.length + '</b> 条账本记录 JSON', 'g');
    });

    $('l-refresh').addEventListener('click', render);
    $('main').querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { LEDGER_FILTER = b.dataset.f; render(); }));
    // 时间预设绑定（manual#155）：与结果筛选同模式（改状态→重渲染）
    $('main').querySelectorAll('[data-tr]').forEach((b) => b.addEventListener('click', () => { LEDGER_TIME = b.dataset.tr; render(); }));
    bindRows();
    const deepBtn = $('l-deep');
    if (deepBtn) deepBtn.addEventListener('click', () => deepSearch(($('l-q').value || '').trim()));
    const q = $('l-q');
    if (q) {
      q.addEventListener('input', () => { LEDGER_Q = q.value; paint(); });
      q.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const rows = LEDGER.filter(ledgerMatch);
        if (rows.length === 1) showTrace(rows[0].traceId);        // 唯一命中直接打开，少一次点击
        else if (rows.length > 1) toast('匹配 ' + rows.length + ' 条，继续输入以缩小范围', 'y');
        else deepSearch(q.value.trim());                          // 本地 0 命中 → 深度搜索更早的 500 条（manual#92）
      });
    }
  }

  async function showTrace(id) {
    // 失败处理（manual#260，#258 同款）：点行开抽屉不在 render 的 try 里——接口失败时
    // 未处理拒绝，运营点行毫无反应（不弹抽屉也不报错）。writeErr 分类 toast。
    let d;
    try {
      d = await api('traces/' + encodeURIComponent(id));
    } catch (e) { const r = writeErr('开详情', e); toast(r.text, r.tone); return; }
    const t = d.trace;
    // 步骤耗时条（manual#110）：offsetMs 是累计偏移，步骤耗时=相邻 offset 差。文本时间线要靠
    // 心算找慢步（实测 3685ms 的请求里 upstream_response 吃 3657ms，纯数字看不出来）——每步加
    // 自身耗时+按占比的横条，「哪一步慢」变成一眼可见。条放第三列 span 内（.step 是 66/40/1fr grid）。
    let prevOff = 0;
    // 同名 stage 加序号（manual#275）：阶梯别名请求有两个 route step——第一个是阶梯计划
    // （『档位阶梯共 5 阶：…』），第二个才是实际路由（带 model=）。舞台名相同会看混，重复
    // 出现时标 #1/#2；单 step 的 stage 不加（不添噪）。
    const stageCount = {};
    for (const s of (t.steps || [])) stageCount[s.stage] = (stageCount[s.stage] || 0) + 1;
    const seen = {};
    const srows = (t.steps || []).map((s) => {
      const dur = Math.max(0, (s.offsetMs || 0) - prevOff);
      prevOff = s.offsetMs || 0;
      seen[s.stage] = (seen[s.stage] || 0) + 1;
      return { s, dur, idx: stageCount[s.stage] > 1 ? seen[s.stage] : 0 };
    });
    const maxDur = Math.max(1, ...srows.map((r) => r.dur));
    const step = (r) => '<div class="step"><span class="dim">+' + r.s.offsetMs + 'ms</span><span class="' + (r.s.ok ? 'y' : 'n') + '">' +
      (r.s.ok ? 'ok' : 'FAIL') + '</span><span><b>' + esc(r.s.stage) + (r.idx ? ' #' + r.idx : '') + '</b> ' + esc(r.s.summary) +
      (r.s.error ? ' <span class="n">' + esc(r.s.error) + '</span>' : '') +
      (r.s.detail ? ' <span class="dim">' + esc(JSON.stringify(r.s.detail)) + '</span>' : '') +
      ' <span class="dim" style="font-size:11px">' + formatNumber(r.dur) + 'ms</span>' +
      '<span style="display:block;height:3px;margin-top:3px;background:var(--chip);border-radius:99px;overflow:hidden"><i style="display:block;height:100%;width:' + (r.dur / maxDur * 100).toFixed(1) + '%;background:var(' + (r.s.ok ? '--ok' : '--err') + ')"></i></span></span></div>';
    // 排障摘要序列化（manual#88）：客户报障→账本搜索→抽屉看步骤后，下一句是"把摘要发我"——
    // 纯文本含 request-id/结果/步骤时间线，直接贴进工单/会话；与 #84 搜索、#87 事件复制同链
    const traceText = () =>
      'request-id: ' + t.requestId + '\\n' +
      'trace-id: ' + t.traceId + '\\n' +
      '时间: ' + TS(t.startedAt) + '\\n' +
      '模型: ' + (t.model || '-') + '\\n' +
      '结果: ' + t.outcome + ' · 耗时 ' + ms(t.durationMs) + (t.failedAtStage ? ' · 失败于 ' + t.failedAtStage : '') + '\\n' +
      '步骤:\\n' + srows.map((r) => '  +' + ms(r.s.offsetMs) + ' ' + (r.s.ok ? 'ok  ' : 'FAIL') + ' ' + r.s.stage + (r.idx ? ' #' + r.idx : '') + ' (' + ms(r.dur) + ') — ' + r.s.summary + (r.s.error ? ' | ' + r.s.error : '')).join('\\n');
    drawer('请求详情 · ' + esc(t.requestId), \`
      <div class="note"><b>结果：</b>\${esc(t.outcome)} · 耗时 \${ms(t.durationMs)}\${t.failedAtStage ? ' · 失败于 <b>' + esc(t.failedAtStage) + '</b>' : ''}</div>
      <div class="kv">\${kv('traceId', t.traceId)}\${kv('requestId', t.requestId)}\${kv('模型', t.model || '—')}\${kv('开始时间', TS(t.startedAt))}</div>
      <h2 style="margin:16px 0 6px">步骤时间线</h2>
      <div class="steps">\${srows.map(step).join('')}</div>
      <div class="note" style="margin-top:14px">客户端可带 <span class="mono">x-relay-verify-nonce</span> 请求内容 HMAC，
      用同一 nonce 对收到的响应体重算即可自证字节未被篡改。</div>
      <h2 style="margin:16px 0 6px">对比另一条 <span class="dim" style="font-size:11px">（manual#99：同一客户一成一败时，贴另一条 trace-id 看差在哪一步）</span></h2>
      <div style="display:flex;gap:8px">
        <input id="tf-other" placeholder="另一条 trace-id" style="flex:1">
        <button class="bare" id="tf-diff">对比</button>
      </div>
      <div id="tf-result" style="margin-top:8px"></div>\`,
      '<button class="bare" id="tr-copy">复制排障摘要</button><button class="pri" id="tr-ok">关闭</button>');
    $('tr-ok').addEventListener('click', closeDrawer);
    $('tr-copy').addEventListener('click', () => copyText(traceText(), '排障摘要已复制（request-id/结果/步骤时间线）'));
    // 对比另一条 trace（manual#99）：API 的 ?diff= 早有（diffTraces），GUI 首次暴露。
    // 语义：diffTraces(对方, 本条)——diverged.a=对方摘要/.b=本条摘要，durationDelta=本条-对方。
    $('tf-diff').addEventListener('click', async () => {
      const other = $('tf-other').value.trim();
      if (!other) return toast('先贴另一条 trace-id', 'y');
      const box = $('tf-result');
      box.innerHTML = '<div class="dim">对比中…</div>';
      try {
        const r = await api('traces/' + encodeURIComponent(id) + '?diff=' + encodeURIComponent(other));
        const df = r.diff;
        if (!df) { box.innerHTML = '<div class="dim">对方 trace 不存在，或两步序列无可比阶段</div>'; return; }
        const chip = (ok) => '<span class="' + (ok ? 'ok">ok' : 'n">FAIL') + '</span>';
        const rows = (df.diverged || []).map((x) =>
          '<tr><td class="mono">' + esc(x.stage) + '</td><td>' + chip(x.aOk) + ' ' + esc(x.a) + '</td><td>' + chip(x.bOk) + ' ' + esc(x.b) + '</td></tr>').join('');
        box.innerHTML =
          '<div class="note' + (df.sameOutcome ? '' : ' warn') + '"><b>对比</b> · 结果' + (df.sameOutcome ? '相同' : '<b>不同</b>') +
          ' · 耗时差 ' + (df.durationDeltaMs >= 0 ? '+' : '') + formatNumber(df.durationDeltaMs) + 'ms（本条−对方）</div>' +
          (rows ? '<table><tr><th>阶段</th><th>对方 ' + esc(String(df.traceA).slice(0, 8)) + '</th><th>本条 ' + esc(String(df.traceB).slice(0, 8)) + '</th></tr>' + rows + '</table>'
                : '<div class="dim">两 trace 的可比步骤摘要完全一致</div>') +
          ((df.onlyInA || []).length ? '<div class="dim" style="font-size:12px;margin-top:6px">仅对方有的阶段：' + df.onlyInA.map(esc).join('、') + '</div>' : '') +
          ((df.onlyInB || []).length ? '<div class="dim" style="font-size:12px;margin-top:6px">仅本条有的阶段：' + df.onlyInB.map(esc).join('、') + '</div>' : '');
      } catch (e) { box.innerHTML = '<div class="err">对比失败：' + esc(e.message) + '</div>'; }
    });
  }

  /* ============ 信任（把设计红线摆在明面上） ============ */
  async function vTrust() {
    let keys = [];
    let keysFail = '';
    // 取数失败不再静默 ignore（manual#374）：此前失败→keys=[]→页面显示『暂无 key』——
    // 把取数失败伪装成空态（客户文档页上运营会被误导：以为真没 key）。ops 页 fail-soft
    // 同款：记录失败原因，区块顶部给可见警告，表格照显但带上『非真实清单』标注。
    try { keys = (await api('keys')).keys || []; } catch (e) { keysFail = (e && e.message) ? e.message : '网络错误'; }
    const INV = [
      ['A1', '成功零改写', '上游 2xx 响应体与 SSE 帧逐字节原样透传。唯一例外：上游回显的 model 与客户端请求不一致时改写回请求名（严格解码器会因此崩），只改这一个字段。',
       'e2e: 成功响应不含 relay_attribution ／ 流式 SSE 逐帧结构 ／ engine: 响应体原样透传'],
      ['A2', '错误只增不改', '归因作为附加字段挂在 error.relay_attribution（或仅响应头 X-Relay-Attribution）。上游 message 与 code 一律保留原值，缺失的 type/param 才补齐。',
       'engine: 透传上游错误体 + 附带归因 ／ attribution: 六种上游错误体形态'],
      ['A3', 'fail-open 不可破', '预检/归因/度量/轨迹/指纹任一环节异常都静默回退原行为，绝不做主流程的单点故障。唯一 fail-closed 的是鉴权（安全边界）。',
       'loss: Meter 在 store 抛异常时 fail-open ／ precheck: 超预算放行 ／ 概览可见兜底计数'],
      ['A4', '不落用户正文', '默认不存 prompt/completion 正文；指纹用 HMAC 截断 16 字符（非裸 sha256，防字典反推）；额度与度量只存计数。',
       'loss: 指纹只输出 HMAC 前缀，不泄漏正文'],
    ];
    $('main').innerHTML = \`
      <div class="note"><b>这一页把设计红线连同它的自动化测试摆在明面上。</b>不用翻文档、不用信口头承诺——
        每条后面都写着它在哪组测试里被钉住。测试规模以 <span class="mono">npm test</span> 与
        <span class="mono">bash scripts/smoke.sh</span> 的<b>实际输出</b>为准 ——
        写死在页面上的数字一定会过期（这一句原本写的是"179 个"，早就对不上了）。</div>
      <section class="block">
        \${INV.map(([id, name, desc, ev]) => '<div class="inv"><b>' + id + ' · ' + esc(name) + '</b>' +
          '<div class="t">' + esc(desc) + '</div><div class="ev">✓ ' + esc(ev) + '</div></div>').join('')}
      </section>

      <section class="block"><h2>给终端用户的自助核对</h2>
        <div class="note" style="margin:0 0 10px">任何响应都带 <span class="mono">x-request-id</span>。
        客户端按下面的方式对拍自己收发的字节哈希，即可证明中转站未改写成功响应——不需要相信我们。</div>
        <div class="note" style="margin:0 0 10px"><b>流式（stream: true）已支持</b>（manual#351 补文档）：请求体带 <span class="mono">"stream": true</span> 即走 SSE——上游的 data: 帧逐字节透传（不缓冲不改写），响应头 <span class="mono">content-type: text/event-stream</span>。断流时响应/事件带 <span class="mono">stream_interrupted</span> 归因（客户端侧重试或切非流式）。注意：字节哈希自验仅对可完整缓冲的**非流式**响应生效——流式请用「请求账本」的步骤时间线核对（运营侧）。</div>
        <pre id="tr-verify-pre"># 1) 发送请求时带上自己的随机数
curl -s -D - \\\\
  -H 'authorization: Bearer &lt;你的 key&gt;' -H 'content-type: application/json' \\\\
  -H 'x-relay-verify-nonce: my-nonce-123' \\\\
  -d '{"model":"...","messages":[...]}' \\\\
  http://&lt;网关&gt;/v1/chat/completions

# 响应头会带回来：
#   x-relay-content-hmac: &lt;HMAC-SHA256(nonce, 响应体字节)&gt;
#   x-relay-content-hmac-nonce / -request-id

# 2) 用同一个 nonce 对自己收到的原始字节重算：
node -e "const c=require('crypto');console.log(c.createHmac('sha256','my-nonce-123').update(require('fs').readFileSync('resp.bin')).digest('hex'))"
# 说明：HMAC 是网关对**自己发出的响应体**（含 model 回显修正后）计算的，
# 相等只能证明"你收到的就是这个响应体"，**不能证明**中转站没做过任何改写
# （2026-09-14 审计 A-P2-8：非 ASCII 百分号编码、model 回显改写、JSON 往返都在
# 计算 HMAC 之前发生）。需要字节级完整性请直接比对上游。
</pre>
        <button class="bare" id="tr-verify-copy" style="margin-top:8px" title="复制整段自验命令（curl+node 两段）——把 <你的key> 和 <网关> 换成真实值再发给客户">复制核对命令</button>
        <div class="dim" style="font-size:11px;margin-top:8px">限制：该证明仅对可完整缓冲的响应（非流式）生效。流式响应请改用「请求账本」里的步骤时间线核对。</div>
      </section>

      <section class="block"><h2>快速接入（OpenAI 兼容）</h2>
        <div class="note" style="margin:0 0 10px">本网关是 <b>OpenAI 兼容</b>端点——任何 OpenAI SDK 只改两行（base_url + api_key）就能用，无需改业务代码。以 Python 官方 SDK 为例（Node/Go/Java 等同理）：</div>
        <pre>from openai import OpenAI

client = OpenAI(
    base_url="https://&lt;网关&gt;/v1",        # 本网关地址（运营提供）
    api_key="sk-relay-&lt;你的 key&gt;",      # 运营提供给你的 key
)

resp = client.chat.completions.create(
    model="mimo-v2.6-flash",                 # 可用模型见 GET /v1/models
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=512,                          # 见下方『推理模型注意』——别给小额
)
print(resp.choices[0].message.content)</pre>
                <div class="note" style="margin:10px 0 0"><b>Anthropic Messages 兼容（POST /v1/messages）</b>（manual#398 实测补文档）：请求体 <span class="mono">system</span> + <span class="mono">messages</span> + <span class="mono">max_tokens</span>（必填），响应是 Anthropic 形状 <span class="mono">{type:"message", content:[{type:"text",text:"…"}], stop_reason:"end_turn", usage:{input_tokens,…}}</span>——Claude Code 等 Anthropic SDK 把 base_url 指到本网关即可用。<b>模型范围：仅 agnes 系</b>（实测 agnes-2.0/2.5/3.0-flash 全 200；mimo/step 系走这个端点会 404 model_not_found——那些模型请用 /v1/chat/completions）。</div>
        <div class="note" style="margin:10px 0 0"><b>OpenAI Responses 兼容（POST /v1/responses）</b>（manual#398 实测补文档）：请求体 <span class="mono">input</span>（必填，缺失 400）+ <span class="mono">max_output_tokens</span>，响应是 Responses 形状 <span class="mono">{object:"response", id:"resp_…", output:[…], output_text:"…", usage:{input_tokens,output_tokens}}</span>。注意：推理模型的 <span class="mono">output[]</span> 首项类型是 <span class="mono">reasoning</span>（思考段，非最终答案）——取可见文本用 <span class="mono">output_text</span> 便捷字段（或 output[] 里最后的 message 项）。</div>
<div class="note" style="margin:10px 0 0"><b>推理模型注意（mimo 全系，manual#364 实测）</b>——mimo 是带推理的模型，实测三个行为，客户端必须知道：①<b>max_tokens 要先给推理留够</b>：推理 token 优先于可见内容消耗生成配额——prompt 触发较多推理时，小额 max_tokens（实测 64）会拿到超出配额的 completion_tokens（72）、<span class="mono">finish_reason=length</span> 且<b>可见内容为空</b>（等十几秒到一两分钟收到空回复）；是否空回复取决于该 prompt 触发多少推理（同一 32 额度下简单问句有内容、稍复杂问句会空）——生产环境给 ≥256，短测试也要 ≥128，并在客户端做空回复兜底（加大额度重试）；②<b>延迟分两段</b>：首字节慢（24h 均值 ~11s、p95 ~35s，繁忙时尾部长达 100s+）——客户端超时按 120s+ 设，同步调用建议配进度提示或改流式；③<b>流式可绕开整段空等</b>：带 <span class="mono">"stream": true</span> 后逐帧收到内容、不用等推理全部完（但首帧仍要等上游第一个 token，实测 ~20s）；断流会有 stream_interrupted 归因，可重试。</div>
        <div class="dim" style="font-size:11px;margin-top:8px">以上数字是 manual#364 在现网负载下的实测值（2 核共享主机），会随上游负载波动——把客户端超时和 max_tokens 按上面的建议值设，就不会踩空。</div>
      </section>

      <section class="block" id="tr-endpoints"><h2>客户端可用端点 <span class="spacer"></span><button class="bare" id="tr-endpoints-copy" style="font-size:11px" title="复制端点表（端点 | 鉴权 | 它回答什么）——转发客户文档时不用手动划选表格">复制端点表</button><span class="dim" style="font-size:11px;text-transform:none">manual#239 补齐——此前信任页只文档了 chat/ask</span></h2>
        <div class="note" style="margin:0 0 10px">除 <span class="mono">/v1/chat/completions</span>（上方的自验命令）与
        <span class="mono">/v1/kb/&lt;id&gt;/ask</span>（知识库页签）外，客户端还可自助拉取下面这些。
        <b>安全边界</b>：标「公开」的两个端点不带 key 鉴权，默认<b>只允许本机（127.0.0.1）访问</b>；
        远程读取需运维显式开 <span class="mono">server.publicQuotaRemote: true</span> 并自行做反代 IP 白名单。</div>
        <table>
          <tr><th>端点</th><th>鉴权</th><th>它回答什么</th></tr>
          <tr><td class="mono">GET /v1/models</td><td>Bearer key（可选）</td><td>本网关可用模型清单（OpenAI 兼容形状 <span class="mono">{object:&quot;list&quot;, data:[{id,...}]}</span>）；带 key 时按该 key 的白名单过滤——只说这把 key 能用的（未设白名单的 key 看到全量，manual#356 实测：系统内无白名单 key 时带不带 key 输出一致，属正确行为）</td></tr>
          <tr><td class="mono">POST /v1/completions</td><td>Bearer key</td><td>旧版文本补全（manual#361 实测 200）：请求体传 <span class="mono">prompt</span>（不是 messages），响应是 OpenAI 兼容形状 <span class="mono">{object:&quot;text_completion&quot;, choices:[{text, finish_reason}]}</span>——老客户端/库直接用；新集成建议用 chat/completions</td></tr>
          <tr><td class="mono">POST /v1/responses</td><td>Bearer key</td><td><b>OpenAI Responses API 兼容</b>（manual#381 实测 200）：请求体传 <span class="mono">input</span>+<span class="mono">max_output_tokens</span>（不是 messages/max_tokens），响应是 <span class="mono">{object:"response", id:"resp_…", output:[…]}</span> 形状——用 Responses SDK/新版客户端的直接走这个；与 chat/completions 同模型范围</td></tr>
          <tr><td class="mono">POST /v1/messages</td><td>Bearer key</td><td><b>Anthropic Messages 兼容</b>（manual#381 实测）：请求体 <span class="mono">system</span>+<span class="mono">messages</span>+<span class="mono">max_tokens</span>（必填），响应是 <span class="mono">{type:"message", content:[{type:"text"…}]}</span> 形状——Claude Code 等 Anthropic SDK 直接用。<b>注意模型范围：仅 agnes 系</b>（实测 agnes-2.0/2.5/3.0-flash 全 200；mimo/step 系走这个会 404 model_not_found——用 /v1/chat/completions）</td></tr>
          <tr><td class="mono">POST /v1/embeddings</td><td>Bearer key</td><td><b>当前不可用</b>（manual#361 实测）：路由存在但没有任何上游声明 embeddings 能力——传任何模型都返 404 model_not_found。别把它当可用端点集成；需要向量能力找运营确认上游支持后再用</td></tr>
          <tr><td class="mono">GET /v1/quota</td><td>公开（默认仅本机）</td><td>近 1h/5h/24h 的用量（manual#386 实测补字段名）：<span class="mono">windows[]</span> 三个窗口各带 <span class="mono">windowHours:1/5/24</span>、总计（requests/errors/totalTokens/costCny）、速查计数 <span class="mono">byModel/byProvider</span>（纯数字），以及完整明细 <span class="mono">models[]</span>（model/requests/errors/totalTokens/cachedPromptTokens/costCny）与 <span class="mono">providersDetail[]</span>（provider 同款字段）——客户对账用后两个数组</td></tr>
          <tr><td class="mono">GET /v1/panel</td><td>公开（默认仅本机）</td><td>网关状态面板：上游健康、最近请求轨迹（含上游错误文案）、key 摘要、时序桶</td></tr>
          <tr><td class="mono">GET /v1/attribution/catalog</td><td>公开</td><td>错误归因目录：上游错误码→中文含义+建议动作+可恢复性（排障页同源）</td></tr>
        </table>
        <div class="dim" style="font-size:11px;margin-top:8px">提示：/v1/quota 与 /v1/panel 的 traces 参数控制轨迹条数（1-100，默认 30，manual#198）；model 字段来自 route 步骤提取（manual#227），可按模型搜索。<b>体积</b>（manual#327 实测）：/v1/panel 默认（30 条）约 56KB，每条轨迹约 1KB——轮询场景按需调小（traces=10 约 41KB、traces=3 约 36KB 触底；traces=100 约 110KB）；/v1/quota 约 5.4KB、/v1/models 约 2KB。服务端暂未开响应压缩（签字项⑰），轮询频繁的客户端建议带 traces 上限+本地缓存。</div>
        <h3 style="margin:14px 0 6px;font-size:13px">客户端错误码（manual#343 实测补录）</h3>
        <table>
          <tr><th>HTTP</th><th>error.code</th><th>含义与处理</th></tr>
          <tr><td class="mono">400</td><td class="mono">invalid_request / question_required</td><td>参数问题。question_required 只对 <span class="mono">/v1/kb/&lt;id&gt;/ask</span> 生效（question 缺失，也接受 query 别名）。<b>注意</b>（manual#378 实测纠错）：chat 的 messages 空/缺失<b>不会被中转层预检</b>——请求会到上游被拒，400 报文是上游原文透传（如 "Param Incorrect"，code 显示上游原值）——带 max_tokens 修好 messages 即可，别按本表的参数错排查。</td></tr>
          <tr><td class="mono">401</td><td class="mono">missing_key</td><td>请求没带 <span class="mono">Authorization: Bearer &lt;key&gt;</span> 头——<b>最常见的集成失误</b>（manual#378 实测：不是 key 无效，是根本没带）。检查客户端的鉴权头拼接；message 里有正确格式示例。</td></tr>
          <tr><td class="mono">401</td><td class="mono">invalid_key</td><td>key 无效/已轮换。message 带密钥指纹——拿它和管理员核对是哪把 key；正在用旧 key 的客户端会批量撞这个。</td></tr>
          <tr><td class="mono">401</td><td class="mono">key_disabled</td><td>key 被管理员<b>停用</b>（manual#365 起的可逆路径：停用期间鉴权同等 401，但 key 还在列表里可随时恢复）。message 会指名是哪把 key——找运维在 /admin 重新启用即可，不用换 key。</td></tr>
          <tr><td class="mono">401</td><td class="mono">expired_key</td><td>key 已过有效期（message 带过期时刻 UTC）。找运维续期或换一把新 key。</td></tr>
          <tr><td class="mono">403</td><td class="mono">kb_forbidden</td><td>该 KB 设了允许的 key 白名单，当前 key 不在内（manual#395 实测纠错：文档原写 <span class="mono">kb_not_allowed</span>——**这个码在网关不存在**，按 error.code 做分支的客户端会整支漏掉；真实码是 kb_forbidden，报文带 KB id 与 key id）。找管理员把 key 加进 allowedKeys。</td></tr>
          <tr><td class="mono">403</td><td class="mono">model_not_allowed</td><td><b>模型存在，但这把 key 的白名单里没有它</b>（manual#378 实测：专卖/限层 key 的典型场景）。message 会列出该 key 可用的模型清单——照着换模型名即可，不用找运维（除非要扩容白名单）。</td></tr>
          <tr><td class="mono">404</td><td class="mono">model_not_found</td><td>模型名没有上游声明支持（这是<b>模型清单问题，不是上游故障</b>）。GET /v1/models 拿可用清单；ask 的 model 必填，不带也是这个错。</td></tr>
          <tr><td class="mono">404</td><td class="mono">kb_not_found</td><td>KB id 不存在。拼写检查；KB 清单问管理员。</td></tr>
          <tr><td class="mono">404</td><td class="mono">unknown_endpoint</td><td>路径不在支持列表（message 列出全部受支持端点）——检查 URL 拼写（如多打了 /v1）。</td></tr>
          <tr><td class="mono">405</td><td class="mono">method_not_allowed</td><td>路径对但 HTTP 方法错（如用 GET 打 /v1/chat/completions）——message 会说明只接受什么方法。</td></tr>
          <tr><td class="mono">400</td><td class="mono">invalid_request_error（坏 JSON）</td><td>请求体不是合法 JSON（manual#378 实测：截断/尾逗号/单引号都会中）。message 会带解析器位置提示；序列化层修好再发。</td></tr>
          <tr><td class="mono">429</td><td class="mono">quota_exceeded</td><td>本周期配额用完（token 或金额）。等下一周期或联系管理员扩容/重置。</td></tr>
          <tr><td class="mono">429</td><td class="mono">too_many_concurrent</td><td>在途请求数超过本层并发上限（manual#352 实测：free 4 / standard 32 / pro 128）。网关会<b>立即拒绝</b>（几十毫秒，不占用上游额度）——客户端做并发控制（信号量/队列）或错峰重试即可。</td></tr>
          <tr><td class="mono">429</td><td class="mono">rate_limited</td><td>本分钟请求数超过本层速率上限（manual#354 实测：free 20 / standard 300 / pro 1200 RPM，固定窗口按自然分钟计，整点重置）。网关同样<b>立即拒绝</b>（不占用上游额度）——按 error.relay_attribution.suggested_next.retryAfterMs 退避后重试（响应里带了精确到毫秒的等待值，第 21 次请求实测拿到 56.1s），或直接降低请求频率。</td></tr>
          <tr><td class="mono">502/503</td><td class="mono">upstream_error</td><td>上游真故障。看 message 里的归因；可重试——带 X-Relay-Attribution 响应头（同 error.relay_attribution 字段）供排障。</td></tr>
        </table>
        <div class="dim" style="font-size:11px;margin-top:8px">错误响应统一形状 <span class="mono">{ error: { message, type, code } }</span>；成功响应零附加字段。重试建议只对 429/502/503 有意义——400/401/403/404 重试不会变好。<b>请求体超上限</b>（默认 8MB，ops 页可查可调）时网关<b>直接断开连接、不返回错误 JSON</b>（manual#378 实测：客户端看到的是 ECONNRESET / curl exit 56，没有 HTTP 响应）——大上下文/批量 payload 场景先确认上限再发。</div>
      </section>

      <section class="block"><h2>你的凭据与用量</h2>
        \${keysFail ? '<div class="note warn" style="margin:0 0 10px"><b>key 列表取数失败：</b>' + esc(keysFail) + '——下面表格是空占位，<b>不是真实 key 清单</b>（勿据此判断有无 key）。稍后点右上角 ↻ 重试。</div>' : ''}
        <table><tr><th>Key</th><th>分层</th><th>状态</th><th>本周期 token</th><th>请求数</th></tr>
        \${keys.length ? keys.map((k) => '<tr><td class="mono">' + esc(k.id) + '</td><td>' + esc(k.tier) + '</td><td>' + (k.enabled ? '<span class="chip g">生效中</span>' : '<span class="chip">已禁用</span>') + '</td><td class="mono">' + formatNumber(k.usage.tokens) + '</td><td class="mono">' + formatNumber(k.usage.requests) + '</td></tr>').join('') : '<tr><td colspan="5" class="dim">暂无 key——用右上角「新建 key」创建；key 是客户端调用的唯一凭据，没有它谁也调不通</td></tr>'}
        </table>
        <div class="dim" style="font-size:11px;margin-top:8px">这里只显示你自己的 key（面板以管理令牌鉴权，因此展示全量；对客户暴露时请按 tenantId 过滤）。</div>
      </section>\`;

    // 复制自验命令（manual#111）：信任页是给客户看的——运营转发时要连命令一起发，
    // 此前只能手动划选整块 pre（还容易漏选）。按钮复制 pre 纯文本（curl+node 两段），
    // toast 提示替换占位符——与 #83 模型命令、#88/#90 排障摘要同链。
    $('tr-verify-copy').addEventListener('click', () => {
      const pre = $('tr-verify-pre');
      if (pre) copyText(pre.textContent, '自验命令已复制——把 <你的key> 和 <网关> 换成真实值再发给客户');
    });
    // 复制客户端端点表（manual#339）：运营转发客户文档时只能手动划选表格（还容易漏列）——
    // 与 #155 复制链同族：表格转纯文本（每行「端点 | 鉴权 | 它回答什么」）。
    $('tr-endpoints-copy').addEventListener('click', () => {
      const rows = [...document.querySelectorAll('#tr-endpoints table tr')].map((tr) =>
        [...tr.children].map((td) => (td.textContent || '').trim()).join(' | '));
      if (rows.length) copyText(rows.join(String.fromCharCode(10)), '客户端端点表已复制（' + (rows.length - 1) + ' 个端点：端点 | 鉴权 | 它回答什么）');
    });
  }

  /* ============ 知识库（垂直 Agent 能力） ============ */
  async function vKb() {
    const host = $('main');
    let kbState;
    try { kbState = await api('kb'); } catch (e) { if (e.status === 404) { kbState = { enabled: false }; } else { throw e; } }

    if (!kbState || !kbState.enabled) {
      host.innerHTML = 
        '<div class="note"><b>知识库能力未启用。</b>在配置里加一段 <span class="mono">kb.path</span>（例如 <span class="mono">data/kb.db</span>）后重启网关即可创建知识库。' +
        ' 启用后本页可：创建 KB → 灌入文档 → 检索 → 通过 <span class="mono">POST /v1/kb/\{id\}/ask</span> 让模型带上你的知识作答。</div>' +
        '<div class="dim" style="font-size:12px">当前健康：' + esc((kbState && kbState.health) ? JSON.stringify(kbState.health) : '（未配置）') + '</div>' +
        '<div class="note" style="margin-top:14px">客户端问答端点（带 Bearer key）：<pre>POST /v1/kb/&lt;id&gt;/ask&#10;Content-Type: application/json&#10;Authorization: Bearer &lt;key&gt;&#10;&#10;{ &quot;model&quot;: &quot;&lt;这把 key 可用的模型&gt;&quot;, &quot;question&quot;: &quot;...&quot;, &quot;topK&quot;: 5 }</pre><div class="dim" style="font-size:12px;margin-top:6px"><b>model 必填</b>（ask 把检索结果注入后走 chat 链路，没有默认模型——不带会 404 model_not_found）；可用模型见 GET /v1/models 或本页模型别名。<b>别名/档位阶梯名（如「极速-any」）对白名单 key 不可用</b>（manual#402 实测）：白名单按**请求原名**校验——白名单 key 用 ladder 名会 403 model_not_allowed（报文带你这把 key 的可用清单），不带白名单的 key 才能用别名；白名单 key 请填白名单内的真实模型名。topK 取值 1-20（缺省 5，检索块数，超上限自动钳制；边界值 0/超限不会报错）；question 也接受 query 别名。该 KB 若设了允许的 key 白名单，其他 key 会收到 403。<b>响应是 OpenAI 兼容的 chat.completion</b>（choices/usage 等标准字段）——检索到的内容已注入进 prompt；模型的回答<b>通常</b>会用 [1][2] 标注引用了第几块（manual#387 实测纠偏：这是<b>模型行为不是保证</b>——同一问题复测出现过零标注的 196B 回答，客户端解析勿依赖引用标注存在，按纯 Markdown 读 content）；没有独立的 hits 数组（那是管理面检索的形状，两边别混）。注意：管理面检索按文档去重（同一篇不重复出现），客户端 ask 是分块级 top-K（RAG 喂料用）。<b>实测响应示例</b>（manual#337，#326 e2e 实录，问『网关迭代优化的运维注意事项』topK=3）：<pre>{&#10;  &quot;object&quot;: &quot;chat.completion&quot;,&#10;  &quot;choices&quot;: [{&#10;    &quot;index&quot;: 0,&#10;    &quot;message&quot;: {&#10;      &quot;role&quot;: &quot;assistant&quot;,&#10;      &quot;content&quot;: &quot;# 网关迭代优化运维注意事项[1]\\n\\n## 一、迭代方法纪律[1]\\n1. 先读错题本……&quot;&#10;    },&#10;    &quot;finish_reason&quot;: &quot;stop&quot;&#10;  }],&#10;  &quot;usage&quot;: { &quot;prompt_tokens&quot;: 1229, &quot;completion_tokens&quot;: 1594, &quot;total_tokens&quot;: 2823 }&#10;}</pre>content 是Markdown 文本，[1] 对应检索注入的第 1 块（块数=topK，本次 3 块全部命中和运维基线相关文档）；usage 的 prompt_tokens 含注入的检索内容。解析时只读 choices[0].message.content 与 finish_reason 即可。</div></div>';
      return;
    }

    const kbs = kbState.kbs || [];
    host.innerHTML = 
      '<div class="note"><b>垂直 Agent 知识库。</b>每个知识库可独立灌入文档、按关键词检索（中英文 bigram + TF 加权），再通过 <span class="mono">/v1/kb/{id}/ask</span> 让模型基于你的知识作答。零依赖、可离线。</div>' +
      '<section class="block"><h2>创建知识库</h2>' +
      '<div class="note" style="margin:0 0 8px">必填：名称（唯一）；可选：描述 / 允许访问的 key（逗号分隔，* = 全部 key）/ 显式 id（小写字母数字与 -）</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      '<input id="kb-name" class="inp" maxlength="64" placeholder="名称（唯一，≤64 字）" style="min-width:220px"/>' +
      '<input id="kb-desc" class="inp" maxlength="256" placeholder="描述（可选，≤256 字）" style="min-width:200px"/>' +
      '<input id="kb-allowed" class="inp" maxlength="256" placeholder="allowedKeys（* = 全部）" style="min-width:180px"/>' +
      '<input id="kb-id" class="inp" placeholder="显式 id（可选）" style="min-width:160px"/>' +
      '<button class="btn" id="kb-create">创建</button></div>' +
      '</section>' +
      '<section class="block"><h2>知识库列表 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">点行看文档；编辑改描述/允许 key（manual#97）</span></h2><div id="kb-list"><table><tr><th>id</th><th>名称</th><th>描述</th><th>允许 key</th><th>文档</th><th>分块</th><th>字节</th><th>创建时间</th><th class="act">操作</th></tr></table></div>' +
      '<div id="kb-detail" style="margin-top:14px"></div></section>';

    const refreshList = async () => {
      const s = await api('kb');
      const rows = (s.kbs || []).map((k) => 
        '<tr><td class="mono">' + esc(k.id) + '</td><td>' + esc(k.name) + '</td><td>' + esc(k.description || '') + '</td>' +
        '<td>' + esc(k.allowedKeys || '*') + '</td>' +
        '<td class="mono">' + formatNumber(k.stats && k.stats.docs) + '</td>' +
        '<td class="mono">' + formatNumber(k.stats && k.stats.chunks) + '</td>' +
        '<td class="mono">' + formatNumber(k.stats && k.stats.bytes) + '</td>' +
        '<td class="mono dim" style="font-size:11px">' + TS(k.createdAt) + '</td>' +
        '<td class="act"><button class="btn kb-ask-cmd" data-kb="' + esc(k.id) + '" title="复制该库的 ask 调用命令（垂直 Agent 的问答入口）">ask 命令</button> ' +
        '<button class="btn kb-meta-edit" data-kb="' + esc(k.id) + '">编辑</button> ' +
        '<button class="btn danger kb-meta-del" data-kb="' + esc(k.id) + '" data-name="' + esc(k.name) + '">删除</button></td></tr>').join('');
      const tbl = host.querySelector('#kb-list table');
      tbl.innerHTML = tbl.querySelector('tr').outerHTML + (rows || '<tr><td colspan="9" class="dim">尚无知识库，先创建一个</td></tr>');
    };

    const refreshDocs = async (id) => {
      const d = await api('kb/' + encodeURIComponent(id) + '/docs');
      const docs = d.docs || [];
      const detail = host.querySelector('#kb-detail');
      detail.innerHTML = '<h3>文档 · ' + esc(id) + '</h3>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">' +
        '<button class="btn" id="doc-export" title="导出本库全部文档为 JSON（备份/审阅/清理前留底用——含 id/标题/来源/正文/分块数，可直接送人）">导出 JSON</button>' +
        '<span class="dim" style="font-size:11px">docs 接口本就返回正文，导出零额外请求；篇数多时文件较大属正常</span></div>' +
        '<div class="note" style="margin:0 0 8px">灌入文档：' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="doc-title" class="inp" maxlength="128" placeholder="标题（≤128 字）" style="min-width:180px"/>' +
        '<input id="doc-source" class="inp" placeholder="来源（可选）" style="min-width:160px"/>' +
        '<textarea id="doc-content" class="inp" placeholder="正文" rows="3" style="min-width:300px"></textarea>' +
        '<button class="btn" id="doc-add">加文档</button><button class="btn" id="doc-batch" title="一次灌入多篇（# 标题 开头，--- 分隔）">批量…</button></div></div>' +
        '<input id="doc-q" class="inp" placeholder="🔍 过滤文档（标题 / id / 来源）" style="width:100%;margin-bottom:8px">' +
        '<table id="doc-tbl"><tr><th>id</th><th>标题</th><th>来源</th><th>分块</th><th>操作</th></tr></table>' +
        // 检索语义提示（manual#186）：分词器对英文是整词匹配且 . _ - 算词内字符——
        // 『tier』搜不到含 TIER_LABEL/k.tier 的块（分成 tier_label/k.tier 整词），
        // 『tiers』也搜不到『tier』。无词干化，这是能力层既定特性（改要签字）；
        // 白名单内把语义写到明处，运营不用靠猜。中文不受影响（bigram）。
        '<div style="margin-top:14px" class="note" style="margin:0 0 8px">检索（中文任意词；英文<b>整词</b>匹配——<span class="mono">k.tier</span>/<span class="mono">TIER_LABEL</span> 算一个词，搜 <span class="mono">tier</span> 不中；无词干化，搜不到时换个写法）：' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="kb-q" class="inp" placeholder="查询，如：失败归因" style="min-width:260px"/>' +
        '<input id="kb-topk" class="inp" type="number" min="1" max="20" placeholder="topK" value="5" style="width:70px" title="取前几篇相关文档（1-20；按文档去重，同一篇不重复出现）"/>' +
        '<label class="sub" style="align-self:center" title="勾选后不去重、直接回 topK 个原始分块——即客户端 ask 的检索口径（同一篇可占多席）；默认按文档去重（每篇取其最高分块）">' +
        '<input type="checkbox" id="kb-chunks"> RAG 视角</label>' +
        '<button class="btn" id="kb-search">检索</button></div></div>' +
        '<div id="kb-results" style="margin-top:8px"></div>';
      // 批量灌入（manual#95）：KB 播种是 N 篇一轮的工作流。粘贴区格式：每篇以 '# 标题' 开头、
      // 篇与篇之间用单独一行 --- 分隔；先实时解析预览（篇数+标题+缺标题报错）再灌入，杜绝盲灌。
      // 本文件是外层 HTML 模板字面量：全部单引号字符串 + fromCharCode，零反斜杠（#93 根治法）。
      const parseBatch = (text) => {
        const NL = String.fromCharCode(10);
        const sections = [];
        let cur = [];
        for (const line of text.split(NL)) {
          if (line.trim() === '---') { sections.push(cur); cur = []; }
          else cur.push(line);
        }
        sections.push(cur);
        const docs = [];
        const errors = [];
        for (const sec of sections) {
          const nonEmpty = sec.filter((l) => l.trim());
          if (!nonEmpty.length) continue;
          const first = nonEmpty[0].trim();
          if (first.indexOf('# ') === 0) {
            const idx = sec.indexOf(nonEmpty[0]);
            docs.push({ title: first.slice(2).trim(), content: sec.slice(idx + 1).join(NL).trim() });
          } else {
            errors.push(first.slice(0, 24));
          }
        }
        // 50 篇上限（manual#150）：服务端早拦（#95），但 GUI 解析出 100 篇也能点确认、
        // 靠往返才报错——预览阶段就截断并明示，与 note 里的『单次上限 50 篇』对上。
        const truncated = docs.length > 50 ? docs.length - 50 : 0;
        return { docs: docs.slice(0, 50), errors, truncated };
      };
      const batchDrawer = () => {
        drawer('批量灌入 · ' + id,
          '<div class="note">格式：每篇以 <span class="mono"># 标题</span> 开头，篇与篇之间用<b>单独一行</b> <span class="mono">---</span> 分隔；单次上限 50 篇。逐篇灌入，单篇失败不影响其余。</div>' +
          '<div class="f"><label>粘贴区</label><textarea id="ba-text" rows="12" style="width:100%"></textarea></div>' +
          '<div id="ba-preview" class="dim" style="font-size:12px">粘贴后这里显示解析预览</div>' +
          '<div class="f"><label>来源标注（可选）</label><input id="ba-source" placeholder="batch"></div>',
          '<button class="bare" id="ba-cancel">取消</button><button class="pri" id="ba-go" disabled>确认灌入</button>');
        const preview = $('ba-preview');
        const go = $('ba-go');
        const doPreview = () => {
          const r = parseBatch($('ba-text').value);
          const parts = [];
          if (r.docs.length) parts.push('将灌入 <b>' + r.docs.length + '</b> 篇：' + r.docs.map((d) => esc(d.title)).join(' / '));
          if (r.errors.length) parts.push('<span class="err">' + r.errors.length + ' 段缺少 # 标题行：' + r.errors.map(esc).join(' / ') + '</span>');
          if (r.truncated) parts.push('<span class="warn">解析到 ' + (r.docs.length + r.truncated) + ' 篇，超出单次 50 篇上限，仅灌入前 50 篇（其余 ' + r.truncated + ' 篇请分批）</span>');
          if (!r.docs.length && !r.errors.length) parts.push('粘贴后这里显示解析预览');
          preview.innerHTML = parts.join('<br>') || '未解析到文档';
          go.disabled = r.docs.length === 0;
        };
        $('ba-text').addEventListener('input', doPreview);
        $('ba-cancel').addEventListener('click', closeDrawer);
        go.addEventListener('click', async () => {
          const r = parseBatch($('ba-text').value);
          if (!r.docs.length) return;
          const source = $('ba-source').value.trim() || 'batch';
          go.disabled = true;
          go.textContent = '处理中…';
          try {
            const resp = await api('kb/' + encodeURIComponent(id) + '/docs/batch', {
              method: 'POST',
              body: JSON.stringify({ docs: r.docs.map((d) => ({ title: d.title, content: d.content, source })) }),
            });
            closeDrawer();
            // 失败明细直达（manual#181）：后端 results 早返回逐篇 {title,ok,error}，GUI 此前
            // 只显示计数、让运营自己去事件日志翻——批量灌入的失败大多是「缺标题/缺正文」这类
            // 一眼可知的原因，当场列出前三条+余量，修复再灌的成本从「翻日志」降到「读 toast」。
            let failTail = '';
            if (resp.failCount) {
              const fails = (resp.results || []).filter((r) => !r.ok);
              const shown = fails.slice(0, 3).map((r) => '「' + esc(r.title || '?') + '」' + esc(r.error || ''));
              failTail = '，失败 <b>' + resp.failCount + '</b> 篇：' + shown.join('；') +
                (fails.length > 3 ? '；等 ' + fails.length + ' 条（完整记录见事件日志）' : '');
            }
            toast('批量灌入完成：成功 <b>' + resp.okCount + '</b> 篇' + failTail, resp.failCount ? 'y' : 'g');
            await refreshDocs(id);
          } catch (e) { const r = writeErr('批量灌入', e); toast(r.text, r.tone); go.disabled = false; go.textContent = '确认灌入'; }
        });
      };
      host.querySelector('#doc-batch').addEventListener('click', batchDrawer);
      // 表单内回车=加文档（manual#328，#114 模式）：title/source 回车直接提交；
      // doc-content 是 textarea（Enter=换行）不绑。
      for (const did of ['doc-title', 'doc-source']) {
        const el = host.querySelector('#' + did);
        if (el) el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); host.querySelector('#doc-add').click(); }
        });
      }
      host.querySelector('#doc-add').addEventListener('click', async () => {
        const title = host.querySelector('#doc-title').value.trim();
        const content = host.querySelector('#doc-content').value.trim();
        const source = host.querySelector('#doc-source').value.trim();
        if (!title || !content) return toast('标题与正文必填', 'r');
        await api('kb/' + encodeURIComponent(id) + '/docs', { method: 'POST', body: JSON.stringify({ title, content, source }) });
        toast('已加文档');
        await refreshDocs(id);
      });
      const tbl = detail.querySelector('#doc-tbl');
      const head = tbl.querySelector('tr').outerHTML;
      // 文档表过滤（manual#126）：文档数 74 且每轮错题本刷新+Agent 沉淀还在涨，找一篇靠滚动——
      // 同 #107 计数器/keys 页的模式。抽 paintDocs（行渲染+重挂绑定），过滤只重画表格
      // 主体，输入焦点保住（同 ledger/keys/mc-q 的既定模式）。
      const paintDocs = () => {
        const q = (detail.querySelector('#doc-q').value || '').trim().toLowerCase();
        const shown = q ? docs.filter((d) => String(d.title).toLowerCase().includes(q) || String(d.id).includes(q) || String(d.source || '').toLowerCase().includes(q)) : docs;
        tbl.innerHTML = head + (shown.length ? shown.map((doc) =>
          '<tr><td class="mono">' + doc.id + '</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(doc.title) + '">' + esc(doc.title) + '</td><td>' + esc(doc.source || '') + '</td>' +
          '<td class="mono">' + formatNumber(doc.chunkCount) + '</td>' +
          '<td><button class="btn kb-edit-doc" data-doc="' + doc.id + '" data-kb="' + id + '">编辑</button> ' +
          '<button class="btn danger kb-del-doc" data-doc="' + doc.id + '" data-kb="' + id + '">删</button></td></tr>').join('')
          : '<tr><td colspan="5" class="dim">' + (q ? '没有匹配「' + esc(q) + '」的文档' : '尚无文档') + '</td></tr>');
        detail.querySelectorAll('.kb-del-doc').forEach((btn) => btn.addEventListener('click', async () => {
          const docId = btn.dataset.doc;
          const kbId = btn.dataset.kb;
          const doc = docs.find((x) => String(x.id) === docId);
          // 删除确认（manual#134）：KB 删除有爆炸半径确认（#97），单篇文档删除却是秒删——
          // 一次误触就丢一篇（恢复=重新灌入，分块重算）。确认框带标题和分块数：
          // 代价看得见再动手，与 KB 删除同待遇。
          if (!confirm('删除文档 #' + docId + (doc ? '「' + doc.title + '」' : '') + '？它的 ' + (doc ? formatNumber(doc.chunkCount) : '全部') + ' 个分块将一并删除，不可恢复。')) return;
          // 失败处理（manual#260，#258 同款）：删除无 catch 时接口失败=未处理拒绝——
          // 无toast无刷新，运营点了删除像没反应（文档还在列表里，更慌）。writeErr 分类。
          try {
            await api('kb/' + encodeURIComponent(kbId) + '/docs/' + docId, { method: 'DELETE' });
            toast('已删文档');
            await refreshDocs(kbId);
          } catch (e) { const r = writeErr('删文档', e); toast(r.text, r.tone); }
        }));
        detail.querySelectorAll('.kb-edit-doc').forEach((btn) => btn.addEventListener('click', () => editDoc(btn.dataset.doc)));
      };
      paintDocs();
      detail.querySelector('#doc-q').addEventListener('input', paintDocs);
      // 导出 JSON（manual#180）：导出环最后一环——KB 是知识资产（错题本+Agent 沉淀），
      // 备份/审阅/清理前留底都要能落文件（70+ 篇旧文档待清理时尤其需要先留底再动）。
      // docs 列表端点本就返回正文（content 字段），内存里即有全量，零额外请求。
      const dex = detail.querySelector('#doc-export');
      if (dex) dex.addEventListener('click', () => {
        const payload = {
          kbId: id,
          exportedAt: new Date().toISOString(),
          count: docs.length,
          docs: docs.map((d) => ({ id: d.id, title: d.title, source: d.source || '', content: d.content || '', chunkCount: d.chunkCount, createdAt: d.createdAt })),
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        a.download = 'api-relay-kb-' + id + '-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('已导出 <b>' + docs.length + '</b> 篇文档（JSON，含正文）', 'g');
      });
      // 编辑文档（manual#94）：KB 维护闭环的最后一环——此前改内容只能删了重灌。
      // 抽屉预填 GET 详情（正文+分块），保存走 PUT 替换（服务端 delete+add，ID 会变，UI 明示）。
      const editDoc = async (docId) => {
        let d;
        try { d = await api('kb/' + encodeURIComponent(id) + '/docs/' + docId); } catch (e) { return toast('加载文档失败：' + esc(e.message), 'r'); }
        const doc = d.doc || {};
        drawer('编辑文档 #' + docId,
          '<div class="note">保存 = <b>替换</b>：删除旧文档并重新灌入，分块立即重算，<b>文档 ID 会变</b>（内部替换，审计事件 kb.doc_replace）。</div>' +
          '<div class="f"><label>标题</label><input id="ed-title" value="' + esc(doc.title || '') + '"></div>' +
          '<div class="f"><label>来源</label><input id="ed-source" value="' + esc(doc.source || '') + '"></div>' +
          '<div class="f"><label>正文（当前 ' + formatNumber((doc.content || '').length) + ' 字 · ' + formatNumber(doc.chunkCount) + ' 分块）</label>' +
          '<textarea id="ed-content" rows="10" style="width:100%">' + esc(doc.content || '') + '</textarea></div>',
          '<button class="bare" id="ed-cancel">取消</button><button class="pri" id="ed-save">保存替换</button>');
        $('ed-cancel').addEventListener('click', closeDrawer);
        $('ed-save').addEventListener('click', async () => {
          const title = $('ed-title').value.trim();
          const content = $('ed-content').value;
          const source = $('ed-source').value.trim() || 'api';
          if (!title || !content.trim()) return toast('标题与正文必填', 'r');
          try {
            const r = await api('kb/' + encodeURIComponent(id) + '/docs/' + docId, { method: 'PUT', body: JSON.stringify({ title, content, source }) });
            closeDrawer();
            toast('已替换文档：新 ID ' + (r.doc && r.doc.id) + ' · ' + formatNumber(r.doc && r.doc.chunkCount) + ' 分块', 'g');
            await refreshDocs(id);
          } catch (e) { const r = writeErr('保存文档', e); toast(r.text, r.tone); }
        });
      };

      const doKbSearch = async () => {
        const q = host.querySelector('#kb-q').value.trim();
        const topK = Number(host.querySelector('#kb-topk').value || 5);
        if (!q) return toast('查询不能为空', 'r');
        // 失败处理（manual#258）：此前检索无 try/catch——接口失败时 promise 拒绝变成未处理
        // 拒绝，结果区留旧内容、无任何提示（按钮像没反应）。与同页保存/删除同一套
        // writeErr 分类（#193）：输入问题黄显、系统问题红显。
        let r;
        try {
          // RAG 视角（manual#321）：chunks=true 跳过去重回原始块——验证检索质量时要看引擎
          // 实际引用的块（客户端 ask 的口径），默认文档视角不变。
          const ragView = !!host.querySelector('#kb-chunks').checked;
          r = await api('kb/' + encodeURIComponent(id) + '/search', { method: 'POST', body: JSON.stringify({ query: q, topK, chunks: ragView }) });
        } catch (e) {
          host.querySelector('#kb-results').innerHTML = '';
          const w = writeErr('检索', e);
          toast(w.text, w.tone);
          return;
        }
        const results = r.results || [];
        // 视角说明（manual#321）：RAG 视角下同一篇可占多席（实测校准文档能占满 top5）——
        // 把「块数 vs 篇数」显出来，运营一眼看出检索窗口被巨文占了多少。
        const viewNote = r.chunks
          ? '<div class="dim" style="font-size:12px;margin-bottom:4px">RAG 视角：' + formatNumber(results.length) + ' 块来自 ' + formatNumber(new Set(results.map((h) => h.docId)).size) + ' 篇（客户端 ask 的检索口径，同一篇可占多席）</div>'
          : '<div class="dim" style="font-size:12px;margin-bottom:4px">文档视角：' + formatNumber(results.length) + ' 篇（每篇取其最高分块；勾选『RAG 视角』看引擎实际引用的块）</div>';
        host.querySelector('#kb-results').innerHTML = viewNote + (results.length ?
          '<table><tr><th>分块</th><th>文档</th><th>得分</th><th>内容</th></tr>' +
          results.map((h) => '<tr class="click" data-seq="' + h.seq + '" title="点击看全文"><td class="mono">#' + h.seq + '</td><td>' + esc(h.docTitle) + ' <span class="dim mono" style="font-size:11px">#' + esc(String(h.docId)) + '</span></td><td class="mono">' + h.score + '</td><td style="max-width:520px;white-space:pre-wrap">' + esc(h.text.slice(0, 400)) + (h.text.length > 400 ? '<span class="dim"> …（点击展开全文）</span>' : '') + '</td></tr>').join('') + '</table>' :
          '<div class="dim">未检索到相关内容。</div>');
        // 点击分块行看全文（manual#86）：检索结果只截断 400 字，核验检索质量必须看全文——
        // 抽屉承载全文 + 复制按钮（quick_action：直接贴进 prompt/文档，不用手动选中）
        host.querySelectorAll('#kb-results tr[data-seq]').forEach((tr) => tr.addEventListener('click', () => {
          const h = results.find((x) => String(x.seq) === tr.dataset.seq);
          if (!h) return;
          drawer('分块 #' + h.seq + ' · ' + esc(h.docTitle),
            // 文档 id 入抽屉（manual#182）：search hit 的 docId 此前未消费——多分块命中同一文档时
            // （如校准文档两个分块都命中）看不出归属，知道 docId 也能回文档表定位/编辑那篇。
            '<div class="note">得分 <span class="mono">' + h.score + '</span> · 来自文档 <span class="mono">#' + esc(String(h.docId)) + '</span>（' + esc(h.docTitle) + '）· 全文 ' + formatNumber(h.text.length) + ' 字</div>' +
            '<pre>' + esc(h.text) + '</pre>',
            '<button class="bare" id="kb-copy">复制全文</button><button class="pri" id="kb-ok">关闭</button>');
          $('kb-ok').addEventListener('click', closeDrawer);
          $('kb-copy').addEventListener('click', () => copyText(h.text, '分块全文已复制'));
        }));
      };
      host.querySelector('#kb-search').addEventListener('click', doKbSearch);
      // 回车即搜（manual#114）：账本搜索框 Enter 直接搜/深搜的模式已建立，KB 检索框却要移鼠
      // 去点按钮——同一站点的搜索输入键盘行为要一致。查询词在输入框里时 Enter=点检索。
      host.querySelector('#kb-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doKbSearch(); });
    };

    // 表单内回车=创建（manual#328，#114 模式）：无 form 包装，此前填完按 Enter 不提交
    for (const kid of ['kb-name', 'kb-desc', 'kb-allowed', 'kb-id']) {
      const el = host.querySelector('#' + kid);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); host.querySelector('#kb-create').click(); }
      });
    }
    host.querySelector('#kb-create').addEventListener('click', async () => {
      const name = host.querySelector('#kb-name').value.trim();
      const desc = host.querySelector('#kb-desc').value.trim();
      const allowed = host.querySelector('#kb-allowed').value.trim() || '*';
      const id = host.querySelector('#kb-id').value.trim();
      if (!name) return toast('名称必填', 'r');
      try {
        await api('kb', { method: 'POST', body: JSON.stringify({ name, description: desc, allowedKeys: allowed, ...(id ? { id } : {}) }) });
        toast('已创建知识库');
        await refreshList();
      } catch (e) { const r = writeErr('创建知识库', e); toast(r.text, r.tone); }
    });

    await refreshList();
    // 点击 KB 行展开详情（按钮除外——编辑/删除自己处理，别顺带打开文档详情）
    host.querySelector('#kb-list table').addEventListener('click', async (e) => {
      if (e.target.closest('button')) return;
      const tr = e.target.closest('tr');
      if (!tr || !tr.querySelector('td')) return;
      const id = tr.querySelector('td').textContent;
      if (!id || id === 'id') return;
      await refreshDocs(id);
    });
    // KB 元数据编辑（manual#97）：描述/允许 key/owner 可改（名称不可改——store 的 updateKb 不接受 name）
    const editKbMeta = async (kbId) => {
      let s;
      try { s = await api('kb'); } catch (e) { return toast('加载失败：' + esc(e.message), 'r'); }
      const k = (s.kbs || []).find((x) => x.id === kbId);
      if (!k) return toast('知识库不存在: ' + esc(kbId), 'r');
      drawer('编辑知识库 · ' + esc(k.name),
        '<div class="note">名称 <b>' + esc(k.name) + '</b> 不可修改（id 与名称是检索/调用的锚点）。可改：描述、允许调用的 key、归属。</div>' +
        '<div class="f"><label>描述（≤256 字；留空=清除）</label><input id="km-desc" maxlength="256" value="' + esc(k.description || '') + '"></div>' +
        '<div class="f"><label>允许 key（* = 全部；多个用逗号分隔）</label><input id="km-keys" value="' + esc(k.allowedKeys || '*') + '"></div>' +
        '<div class="f"><label>归属（owner，≤64 字；留空=清除）</label><input id="km-owner" maxlength="64" value="' + esc(k.owner || '') + '"></div>',
        '<button class="bare" id="km-cancel">取消</button><button class="pri" id="km-save">保存</button>');
      $('km-cancel').addEventListener('click', closeDrawer);
      $('km-save').addEventListener('click', async () => {
        const description = $('km-desc').value.trim();
        const allowedKeys = $('km-keys').value.trim() || '*';
        const owner = $('km-owner').value.trim();
        try {
          await api('kb/' + encodeURIComponent(kbId), { method: 'PUT', body: JSON.stringify({ description, allowedKeys, owner }) });
          closeDrawer();
          toast('已更新知识库 <b>' + esc(k.name) + '</b>', 'g');
          await refreshList();
        } catch (e) { const r = writeErr('保存知识库', e); toast(r.text, r.tone); }
      });
    };
    // 删除 KB（毁灭性：连文档带分块全删）——后果写在确认里，和 key 轮换一个待遇
    const deleteKbMeta = async (kbId, name) => {
      if (!confirm('删除知识库「' + name + '」（' + kbId + '）？该库的全部文档与分块将一并删除，不可恢复。')) return;
      try {
        await api('kb/delete', { method: 'POST', body: JSON.stringify({ id: kbId }) });
        toast('已删除知识库 <b>' + esc(name) + '</b>', 'y');
        const detail = host.querySelector('#kb-detail');
        if (detail) detail.innerHTML = '';
        await refreshList();
      } catch (e) { toast('删除失败：' + esc(e.message), 'r'); }
    };
    // 复制 ask 命令（manual#106）：KB 闭环的最后一环——文档灌入、检索都有了，「问起来什么样」
    // 还得到处翻文档拼 curl。ask 是垂直 Agent 的入口（/v1/kb/{id}/ask，带客户端 key），
    // 这里一键复制含库 id 的完整命令，key 用占位符（同 #83 模型调用命令的口径）。
    host.querySelectorAll('.kb-ask-cmd').forEach((b) => b.addEventListener('click', () => {
      const kbId = b.dataset.kb;
      // 模型用占位符（manual#402 修坏箭头）：此前硬编码 ladder 名「极速-any」——白名单
      // key 的鉴权按**请求原名**校验（alias/ladder 名不在白名单里），复制过去就是 403
      // model_not_allowed（实测：白名单 key+极速-any=403，无白名单 key=200）。与 #83
      // 起 key 占位符同口径：模型也占位，客户填自己白名单内的名字。
      const cmd = 'curl -s ' + location.origin + '/v1/kb/' + encodeURIComponent(kbId) + '/ask -H "authorization: Bearer <你的key>" -H "content-type: application/json" -d ' + "'" + '{"model":"<这把key可用的模型>","question":"你的问题","topK":5}' + "'";
      copyText(cmd, 'ask 命令已复制——把 <你的key> 和 <模型> 换成真实值（模型必须在这把 key 的白名单内；GET /v1/models 可列出你这把 key 能用的）');
    }));
    host.querySelectorAll('.kb-meta-edit').forEach((b) => b.addEventListener('click', () => editKbMeta(b.dataset.kb)));
    host.querySelectorAll('.kb-meta-del').forEach((b) => b.addEventListener('click', () => deleteKbMeta(b.dataset.kb, b.dataset.name)));
  }

  /* ============ Agent（内部运维/迭代决策环） ============ */
  async function vAgent() {
    const host = $('main');
    // 探测运营 Agent（新端点 agent/tools；404/503 = 未启用或旧版网关）
    let tl;
    try { tl = await api('agent/tools'); } catch (e) { if (e.status === 404 || e.status === 503) { tl = null; } else throw e; }
    if (!tl) {
      host.innerHTML =
        '<div class="note"><b>运营 Agent（平台规则 Agent）未启用。</b>配置里加 <span class="mono">agent.enabled: true</span> 并指定 <span class="mono">agent.clientId</span>（clients 里的一条 key）与 <span class="mono">agent.model</span> 后重启网关即可。' +
        ' Agent 的工具=平台能力+外部 HTTP 工具（受出口闸门约束）；写操作自动挂审批单（异步，批准后执行）。</div>';
      return;
    }

    let sessionId = null;
    host.innerHTML =
      '<div class="note"><b>运营 Agent。</b>多轮对话 + 平台工具（KB 检索/问答、key 核查、流量健康、事件排查）+ 外部 HTTP 工具（出口闸门拦内网/元数据）。' +
      ' 写操作（POST/PUT/DELETE/PATCH）自动挂审批单，批准后异步执行；GET 免审批。所有 LLM 调用走本网关计量链路（client_kind=agent）。</div>' +
      '<section class="block"><h2>对话</h2>' +
      '<div id="ao-log" style="max-height:340px;overflow:auto;border:1px solid var(--bd);border-radius:6px;padding:10px;margin-bottom:8px"><div class="dim" style="font-size:12px">在下面输入运营问题，例如「最近有没有鉴权失败激增？」「知识库里 XX 怎么配置？」</div></div>' +
      '<div style="display:flex;gap:8px"><textarea id="ao-in" rows="2" style="flex:1" placeholder="给运营 Agent 发消息…"></textarea>' +
      '<button class="btn" id="ao-send">发送</button></div>' +
      '<div class="dim" style="font-size:11px;margin-top:4px" id="ao-sid">新会话</div></section>' +
      '<section class="block"><h2>审批队列</h2><div id="ao-appr"><div class="dim">加载中…</div></div></section>' +
      '<section class="block"><h2>工具</h2><div id="ao-tools"></div>' +
      '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<input id="ao-tname" placeholder="工具名(字母开头)" style="width:150px">' +
      '<select id="ao-tmethod"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>' +
      '<input id="ao-turl" placeholder="https://api.example.com/path" style="flex:1;min-width:220px">' +
      '<input id="ao-tdesc" placeholder="说明(可选)" style="width:140px">' +
      '<button class="btn" id="ao-tadd">注册</button></div>' +
      '<div class="dim" style="font-size:11px;margin-top:4px">写操作方法注册后调用时自动挂审批单；出口闸门拒绝内网/保留/云元数据地址。</div></section>' +
      '<section class="block"><h2>执行历史</h2><div id="ao-hist"><div class="dim">尚无记录</div></div></section>';

    const aoLog = (role, html) => {
      const log = host.querySelector('#ao-log');
      const d = document.createElement('div');
      d.style.marginBottom = '8px';
      d.innerHTML = '<span class="chip" style="font-size:10px">' + role + '</span> ' + html;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };

    const refreshTools = () => {
      const rows = (tl.tools || []).map((t) =>
        '<tr><td class="mono">' + esc(t.name) + '</td><td>' + (t.kind === 'http' ? '<span class="chip y">http</span>' : '<span class="chip b">内置</span>') + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc(t.description || '') + '</td>' +
        '<td>' + (t.kind === 'http' ? '<button class="bare" data-tdel="' + esc(t.name) + '">删除</button>' : '') + '</td></tr>').join('');
      host.querySelector('#ao-tools').innerHTML = '<table><tr><th>工具</th><th>类型</th><th>说明</th><th></th></tr>' + rows + '</table>';
      host.querySelectorAll('[data-tdel]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await api('agent/tools/' + encodeURIComponent(btn.dataset.tdel), { method: 'DELETE' });
          toast('已删除工具 ' + esc(btn.dataset.tdel), 'g');
          tl = await api('agent/tools');
          refreshTools();
        } catch (e) { toast('删除失败：' + esc(e.message), 'r'); }
      }));
    };

    const refreshAppr = async () => {
      let d;
      try { d = await api('agent/approvals?status=pending'); } catch { d = { approvals: [] }; }
      const list = d.approvals || [];
      host.querySelector('#ao-appr').innerHTML = list.length ? list.map((a) =>
        '<div class="card" style="margin-bottom:8px"><b>' + esc(a.tool) + '</b> <span class="mono dim" style="font-size:11px">' + TS(a.created_at) + '</span>' +
        '<div class="dim" style="font-size:12px;margin:4px 0">' + esc(JSON.stringify(a.payload)) + '</div>' +
        '<button class="btn" data-aok="' + esc(a.id) + '">批准并执行</button> ' +
        '<button class="bare" data-aorno="' + esc(a.id) + '">拒绝</button></div>').join('')
        : '<div class="dim">没有待审批的写操作</div>';
      host.querySelectorAll('[data-aok]').forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await api('agent/approvals/' + encodeURIComponent(btn.dataset.aok), { method: 'POST', body: JSON.stringify({ action: 'approve', actor: 'panel' }) });
          toast('已批准并执行：' + esc(r.executed ? (r.executed.ok ? '成功' : '失败：' + String(r.executed.content).slice(0, 60)) : ''), r.executed && r.executed.ok ? 'g' : 'y');
          if (r.executed) aoLog('审批', esc('工具执行结果：' + r.executed.content.slice(0, 500)));
          refreshAppr(); refreshHist();
        } catch (e) { toast('审批失败：' + esc(e.message), 'r'); btn.disabled = false; }
      }));
      host.querySelectorAll('[data-aorno]').forEach((btn) => btn.addEventListener('click', async () => {
        try {
          await api('agent/approvals/' + encodeURIComponent(btn.dataset.aorno), { method: 'POST', body: JSON.stringify({ action: 'reject', actor: 'panel' }) });
          toast('已拒绝', 'y'); refreshAppr();
        } catch (e) { toast('操作失败：' + esc(e.message), 'r'); }
      }));
    };

    const refreshHist = async () => {
      let d;
      try { d = await api('agent/history?limit=20'); } catch { d = { runs: [] }; }
      const runs = d.runs || [];
      host.querySelector('#ao-hist').innerHTML = runs.length ? runs.map((r) =>
        '<div class="card" style="margin-bottom:6px;padding:6px 10px">' +
        '<span class="mono" style="font-size:12px">' + esc(r.tool) + '</span> ' +
        (r.ok ? '<span class="chip g" style="font-size:10px">ok</span>' : '<span class="chip r" style="font-size:10px">fail</span>') +
        ' <span class="mono dim" style="font-size:11px">' + TS(r.createdAt) + '</span>' +
        '<div class="dim" style="font-size:12px">' + esc(r.summary) + '</div></div>').join('')
        : '<div class="dim">尚无记录</div>';
    };

    host.querySelector('#ao-send').addEventListener('click', async () => {
      const btn = host.querySelector('#ao-send');
      const inp = host.querySelector('#ao-in');
      const msg = (inp.value || '').trim();
      if (!msg || btn.disabled) return;
      btn.disabled = true;
      inp.value = '';
      aoLog('运营', esc(msg));
      try {
        const body = { message: msg };
        if (sessionId) body.session_id = sessionId;
        const r = await api('agent/chat', { method: 'POST', body: JSON.stringify(body) });
        sessionId = r.session_id;
        host.querySelector('#ao-sid').textContent = '会话 ' + String(sessionId).slice(0, 8);
        aoLog('Agent', esc(r.reply || '(空回复)'));
        if (r.approvals_pending && r.approvals_pending.length) {
          aoLog('系统', '<span class="chip y">已挂 ' + r.approvals_pending.length + ' 条审批单——下方「审批队列」批准后执行</span>');
          refreshAppr();
        }
      } catch (e) {
        aoLog('系统', '<span style="color:#c0392b">发送失败：' + esc(e.message) + '</span>');
      } finally { btn.disabled = false; inp.focus(); }
    });
    host.querySelector('#ao-in').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); host.querySelector('#ao-send').click(); } });

    host.querySelector('#ao-tadd').addEventListener('click', async () => {
      const name = (host.querySelector('#ao-tname').value || '').trim();
      const method = host.querySelector('#ao-tmethod').value;
      const url = (host.querySelector('#ao-turl').value || '').trim();
      const description = (host.querySelector('#ao-tdesc').value || '').trim();
      if (!name || !url) { toast('工具名与 URL 必填', 'y'); return; }
      try {
        await api('agent/tools', { method: 'POST', body: JSON.stringify({ name, method, url, description }) });
        toast('已注册工具 ' + esc(name) + (method === 'GET' ? '（GET 免审批）' : '（写操作，调用时挂审批单）'), 'g');
        tl = await api('agent/tools');
        refreshTools();
        host.querySelector('#ao-tname').value = ''; host.querySelector('#ao-turl').value = ''; host.querySelector('#ao-tdesc').value = '';
      } catch (e) { toast('注册失败：' + esc(e.message), 'r'); }
    });

    refreshTools();
    refreshAppr();
    refreshHist();
  }


  /* ============ 排障（事件日志 / 鉴权失败 / 归因目录） ============ */
  async function vDiag() {
    // kind 筛选走服务端（manual#168）：筛选激活时改拉「最近 500 条该前缀」——此前只客户端
    // 筛已加载 100 条，某类事件超过 100 条外的永远看不到（key 轮换/kb 变更多于 agent 决策
    // 的场景）。计数与前缀按钮仍用全量 100（一次请求两份职责）。
    // 按块降级（manual#189）：本页 5 个独立数据源，任一失败都不该把整页变成只剩一个
    // 「加载失败」toast——出问题时这正是最需要数据的页。失败的块走空态并在页顶汇总说明
    // （A3 fail-open 的 GUI 层对应：局部降级，不整体白屏）。
    const diagFail = [];
    const soft = (p, dflt, label) => api(p).catch((e) => { diagFail.push(label + '（' + (e && e.message ? e.message : '网络错误') + '）'); return dflt; });
    const [ev, evKind, af, cat, te] = await Promise.all([
      // kind 筛选激活时跳过 plain 100 条拉取（manual#335）：表格/前缀计数都走 evKind
      // （下面的 events = evKind.events || ev.events），plain 拉取在筛选态完全不被消费——
      // 白拉 26.7KB。detail=0（manual#301）：表格只要 90 字预览+actor，详情按需拉。
      EV_FILTER === 'all' ? soft('events?limit=100&detail=0' + evLevelQuery(), { events: [] }, '事件日志') : Promise.resolve(null),
      // kind 筛选拉取 500→200（manual#291，性能第一位）：实测 kb 筛选 500 条=92KB gzip，
      // 是全应用最重的一次拉取（keys 页 36KB 的 2.5 倍）——而事件表是全量渲染的，347 行
      // 的 DOM 也已超显示需求。200 条=混合默认（100）的两倍深度、载荷降 ~43%，「多看一
      // 类事件」的语义（#168）不变。首屏/筛选点击的体感是性能第一位的直接战场。
      EV_FILTER === 'all' ? Promise.resolve(null) : soft('events?limit=200&kind=' + encodeURIComponent(EV_FILTER) + '&detail=0' + evLevelQuery(), { events: [] }, '事件日志'),
      soft('auth-failures?limit=50', { total: 0 }, '鉴权失败'),
      soft('attribution/catalog', { failure_reasons: [] }, '归因目录'),
      // 窗口跟全局选择器（manual#318）：此前硬编码 24h——运营切到 7d/30d 后本块仍显示
      // 24h 的失败签名，与顶栏选择器口径不一致；本页其余数据源（events/auth-failures/catalog）
      // 本就不分窗口，top-errors 是唯一窗口化的，对齐选择器。
      soft('top-errors?window=' + win() + '&limit=10', { errors: [] }, '错的是什么'),
    ]);
    const topErrs = te.errors || [];
    const events = (evKind ? evKind.events : null) || ev.events || [];
    // 事件 kind 前缀过滤（manual#109）：Agent 决策每 ~15 分钟一条，100 条窗口里 66% 是 agent.*，
    // 运维事件（key 轮换/kb 变更）被淹没。前缀从数据动态派生——未来新 kind 的过滤按钮自动出现。
    const evPrefixes = [...new Set(events.map((e) => (e.kind || '?').split('.')[0]))];
    const evCounts = { all: events.length };
    for (const e of events) { const pfx = (e.kind || '?').split('.')[0]; evCounts[pfx] = (evCounts[pfx] || 0) + 1; }
    // 服务端已按 kind 过滤（limit=500）；客户端这层对服务端结果幂等，保留作双保险
    const shownEvents = events.filter((e) =>
      (EV_FILTER === 'all' || (e.kind || '').startsWith(EV_FILTER + '.')) &&
      (EV_LEVEL === 'all' || e.level === EV_LEVEL));
    const groups = af.groups || [];
    const codes = af.byCode || [];
    const reasons = cat.failure_reasons || [];
    const lvChip = (l) => '<span class="chip ' + (l === 'error' ? 'r' : l === 'warn' ? 'y' : 'b') + '">' + esc(l) + '</span>';

    // 鉴权失败块：有数据才铺开，没数据给一句人话（避免一页空表格）
    let afHtml;
    if (af.total) {
      afHtml =
        '<div class="grid cards" style="margin-bottom:10px">' +
        tile('被拒次数', formatNumber(af.total), '窗口内累计') +
        tile('不同指纹', formatNumber(af.distinct), '每个指纹 = 一把不同的 key') +
        '</div>' +
        '<div style="margin-bottom:10px">' +
        codes.map((c) => '<span class="chip">' + esc(c.code) + ' × ' + formatNumber(c.count) + '</span>').join(' ') +
        '</div>' +
        '<table><tr><th>原因</th><th>key 指纹</th><th>次数</th><th>首次</th><th>最近</th><th>头形态</th><th>是不是这里签发的</th></tr>' +
        groups.slice(0, 20).map((g) => '<tr><td>' + esc(g.code) + '</td><td class="mono">' + esc(g.fingerprint || '(无 key)') +
          '</td><td class="mono">' + formatNumber(g.count) + '</td><td class="dim">' + esc(TS(g.firstAt)) + '</td><td class="dim">' + esc(TS(g.lastAt)) +
          '</td><td class="mono">' + esc(g.headerForm) + '</td><td>' +
          (g.matchesIssuedKey
            ? '<span class="chip g">命中已签发 key（被禁用/过期）</span>'
            : '<span class="chip y">不是这里签发的（抄错或旧 key）</span>') +
          '</td></tr>').join('') +
        '</table>' +
        // 最近被拒明细（manual#188）：auth-failures 的 recent 数组早返回（at/code/fingerprint/
        // keyLength/headerForm/path）但 GUI 从未消费。path 是 groups 没有的维度——被拒请求打在
        // 哪个端点（/v1/* 是客户端用错 key，/admin/api/* 是有人在探面板）决定了处置方向。
        (af.recent && af.recent.length
          ? '<div style="margin-top:10px"><div class="dim" style="font-size:12px;margin-bottom:4px">最近被拒记录（时间/端点/头形态/key 长度）：</div>' +
            '<table><tr><th>时间</th><th>原因</th><th>端点</th><th>头形态</th><th class="num">key 长度</th></tr>' +
            af.recent.slice(0, 12).map((r) => '<tr><td class="dim">' + esc(TS(r.at)) + '</td><td>' + esc(r.code) + '</td>' +
              '<td class="mono">' + esc(r.path || '') + '</td><td class="mono dim">' + esc(r.headerForm || '') + '</td>' +
              '<td class="mono num dim">' + formatNumber(r.keyLength) + '</td></tr>').join('') + '</table></div>'
          : '');
    } else {
      afHtml = emptyBox('🔑', '窗口内没有被拒的请求', '出现 401 时这里会留下指纹，一眼看出是哪把 key');
    }

    $('main').innerHTML = \`
      \${diagFail.length ? '<div class="note warn" style="margin-bottom:10px"><b>部分数据加载失败：</b>' + diagFail.map(esc).join('；') + '——对应区块显示的是空态而非真实数据，稍后点右上角 ↻ 重试；其余区块数据不受影响。</div>' : ''}
      <div class="note"><b>出问题时先看这一页。</b>三块分别回答：网关自己记了什么（事件日志）、
        客户是不是 key 用错了（鉴权失败指纹）、错误被翻译成了什么（归因目录 —— 它同时是给客户端的契约）。</div>

      <section class="block"><h2>鉴权失败 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">"API 全 401" 的第一现场</span></h2>
        \${afHtml}
      </section>

      <section class="block"><h2>错的是什么 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">窗口内上游失败签名（manual#183）</span></h2>
        \${topErrs.length
          ? '<table><tr><th>失败原因</th><th class="num">次数</th><th>实例</th></tr>' +
            topErrs.map((e) => '<tr><td>' + esc(e.reason) + '</td><td class="mono num">' + formatNumber(e.count) + '</td><td class="mono dim">' + esc(e.example || '') + '</td></tr>').join('') + '</table>' +
            '<div class="dim" style="font-size:11px;margin-top:8px">与上面「鉴权失败」互补：那块管客户端 key（401），这块管上游错误（5xx/超时/限流）。实例列是每条原因的首次样本（model@provider HTTP status）。覆盖范围：进程启动以来' + (te.coveredSince ? '（最早 ' + esc(TS(te.coveredSince)) + '，短于所选窗口是正常的——刚重启过就是这样）' : '') + '。</div>'
          : '<div class="dim">本进程启动以来没有上游失败' + (te.coveredSince ? '（覆盖自 ' + esc(TS(te.coveredSince)) + '）' : '（刚重启，还没有积累）') + '。注意：这块看的是进程内度量，不是全历史——更早的失败去「请求账本」深搜。</div>'}
      </section>

      <section class="block"><h2>事件日志 <span class="spacer"></span><button class="bare" id="ev-csv" title="导出当前筛选事件的 CSV（审计轨迹用：key 轮换/配置变更/熔断的记录归档；BOM+CRLF，Excel 直接打开）">导出 CSV</button><button class="bare" id="ev-refresh">↻</button></h2>
        <div class="row filters">
          \${['all'].concat(evPrefixes).map((f) =>
            '<button class="bare' + (EV_FILTER === f ? ' on' : '') + '" data-evf="' + f + '">' +
            ({ all: '全部', agent: 'Agent', kb: '知识库', key: 'Key 运维' }[f] || f) +
            ' · ' + formatNumber(evCounts[f] || 0) + '</button>').join('')}
        </div>
        <div class="row filters">
          \${['all', 'error', 'warn', 'info'].map((l) =>
            '<button class="bare' + (EV_LEVEL === l ? ' on' : '') + '" data-evl="' + l + '">' +
            ({ all: '全部级别', error: '只看 error', warn: 'warn', info: 'info' }[l] || l) +
            ' · ' + formatNumber(l === 'all' ? events.length : (events.filter((e) => e.level === l).length)) + '</button>').join('')}
        </div>
        <table>
          <tr><th>时间</th><th>级别</th><th>事件</th><th>操作者</th><th>详情</th></tr>
          \${shownEvents.length ? shownEvents.map((e, i) => {
            // 操作者列（manual#214）：actor（IP+UA）此前唯一露出是详情 JSON 尾部，而表格把
            // detail 截到 90 字符——降损更新这类 changed/hot 数组长的事件，actor 正好被切掉，
            // 『是谁改的』必须点行才看得到。审计用途的字段不埋在二级视图里。
            const actor = e.actor != null ? e.actor : ((e.detail && e.detail.actor) || '');  // slim 行顶层 actor（manual#301），全量行 detail.actor
            const ip = actor ? actor.split(' ')[0].replace('::ffff:', '') : '';
            return '<tr class="click" data-ev="' + i + '"><td class="dim">' + esc(TS(e.ts)) + '</td><td>' + lvChip(e.level) + '</td><td class="mono">' + esc(e.kind) + '</td><td class="mono dim">' + (ip ? '<span title="' + esc(actor) + '">' + esc(ip) + '</span>' : '—') + '</td><td class="dim">' + esc(e.brief != null ? e.brief : JSON.stringify(e.detail || {}).slice(0, 90)) + '</td></tr>';
          }).join('') : '<tr><td colspan="5" class="dim">暂无事件——面板上的写动作（建/改/禁 key、灌文档、跑 Agent）会自动记录到这里，不是坏了</td></tr>'}
        </table>
        <div class="dim" style="font-size:11px;margin-top:8px">点任意一行看完整详情。key 轮换/吊销、降损开关改动、上游熔断都会记在这里。</div>
      </section>

      <section class="block"><h2>失败归因目录 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">给客户端的契约</span></h2>
        <div class="dim" style="font-size:12px;margin-bottom:8px">\${esc(cat.description || '')}</div>
        <div style="margin-bottom:10px">
          <span class="chip b">full</span> \${esc((cat.delivery || {}).full || '')}<br>
          <span class="chip">header</span> \${esc((cat.delivery || {}).header || '')}<br>
          <span class="chip">off</span> \${esc((cat.delivery || {}).off || '')}
        </div>
        <table>
          <tr><th>reason</th><th>中文</th><th>可恢复</th><th>建议动作</th></tr>
          \${reasons.map((r) => '<tr><td class="mono">' + esc(r.reason) + '</td><td>' + esc(r['中文'] || '') + '</td><td>' + (r.recoverable ? '<span class="chip g">是</span>' : '<span class="chip r">否</span>') + '</td><td class="mono">' + esc(r.action) + '</td></tr>').join('')}
        </table>
        <div class="dim" style="font-size:11px;margin-top:8px">\${esc((cat.precheck || {}).description || '')}<br>\${esc((cat.precheck || {}).fail_open || '')}</div>
      </section>\`;

    // 导出 CSV（manual#178）：事件日志是审计轨迹（key 轮换/配置变更/熔断/降级），
    // 此前只能截屏——归档/交接时要能落文件。导出当前筛选结果（与表格同源）。
    const ecsv = $('ev-csv');
    if (ecsv) ecsv.addEventListener('click', async () => {  // async（manual#301）：CSV 要全量 detail，按需拉
      const CRLF = String.fromCharCode(13, 10);
      const cell = (c) => {
        const s = String(c == null ? '' : c);
        const need = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf(String.fromCharCode(10)) >= 0 || s.indexOf(String.fromCharCode(13)) >= 0;
        return need ? '"' + s.split('"').join('""') + '"' : s;
      };
      // 操作者列（manual#237）：表格自 #214 起有 actor 列，导出却没有——审计归档时
      // 『是谁从哪台机器改的』要从详情 JSON 里挖。加独立列（IP+UA 全量）。
      const head = ['时间', '级别', 'kind', '操作者', '详情'];
      // 全量详情按需（manual#301）：表格行是 slim（brief 90 字），CSV 要完整 detail——
      // 导出时拉一次全量（首次），之后走缓存。失败则回退 slim 行的 brief（不阻断导出）。
      let fullRows = null;
      try { fullRows = await ensureEvFull(); } catch { /* 回退 brief */ }
      const csvRows = fullRows || shownEvents;
      const rows = [head].concat(csvRows.map((e) => [
        TS(e.ts), e.level, e.kind, (e.detail && e.detail.actor) || '', JSON.stringify(e.detail || {})]));
      const csv = String.fromCharCode(0xFEFF) + rows.map((r) => r.map(cell).join(',')).join(CRLF);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'api-relay-events-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 <b>' + shownEvents.length + '</b> 条事件（当前筛选结果）', 'g');
    });

    $('ev-refresh').addEventListener('click', () => render());
    $('main').querySelectorAll('[data-evf]').forEach((b) => b.addEventListener('click', () => {
      EV_FILTER = b.dataset.evf;
      try { localStorage.setItem('relay_admin_ev_filter', EV_FILTER); } catch { /* 存不上不影响当次 */ }
      render();
    }));
    $('main').querySelectorAll('[data-evl]').forEach((b) => b.addEventListener('click', () => {
      EV_LEVEL = b.dataset.evl;
      try { localStorage.setItem('relay_admin_ev_level', EV_LEVEL); } catch { /* 存不上不影响当次 */ }
      render();
    }));
    $('main').querySelectorAll('[data-ev]').forEach((tr) => tr.addEventListener('click', () => {
      const idx = Number(tr.dataset.ev);
      // 全量详情按需（manual#301）：slim 行只有 90 字预览，抽屉要完整 detail——首次点行拉一次
      // 全量（同查询同顺序，下标对齐），之后走缓存；拉失败回退 slim 行（预览+已有字段）。
      void (async () => {
      let e = shownEvents[idx];
      try { const full = await ensureEvFull(); if (full[idx]) e = full[idx]; } catch { /* 回退 slim 行 */ }
      // 复制整条事件（kind/ts/level/detail）而非只复制 detail——报障/开工单时要的是完整上下文（manual#87）
      drawer('事件 · ' + e.kind,
        '<div class="mono" style="font-size:12px">' + esc(TS(e.ts)) + ' · ' + esc(e.level) + '</div>' +
        '<pre>' + esc(JSON.stringify(e.detail || {}, null, 2)) + '</pre>',
        '<button class="bare" id="ev-copy">复制事件 JSON</button><button class="pri" id="ev-ok">关闭</button>');
      $('ev-ok').addEventListener('click', closeDrawer);
      $('ev-copy').addEventListener('click', () => copyText(
        JSON.stringify({ kind: e.kind, ts: e.ts, level: e.level, detail: e.detail || {} }, null, 2),
        '事件 JSON 已复制（含 kind/ts/level/detail）'));
      })();
    }));
  }

  /* ============ 运维（生效配置 / 降损开关 / 分层策略 / 文本报告） ============ */
  async function vOps() {
    // 按块降级（manual#191，#189 模式推广）：生效配置/降损开关/分层策略是三块独立内容，
    // 任一取数失败不该让整页只剩一个 toast——失败的块显空值，页顶汇总说明。
    const opsFail = [];
    const opsSoft = (p, dflt, label) => api(p).catch((e) => { opsFail.push(label + '（' + (e && e.message ? e.message : '网络错误') + '）'); return dflt; });
    const [cfg, lr, pol, evo, evoLog] = await Promise.all([
      opsSoft('config', {}, '生效配置'),
      opsSoft('loss-reduction', {}, '降损开关'),
      opsSoft('auth-policy', { tiers: {} }, '分层策略'),
      opsSoft('evolution-direction', { candidates: [], setting: null }, '进化方向'),
      opsSoft('events?limit=3&kind=evolution', { events: [] }, '进化方向变更史'),
    ]);
    const sv = cfg.server || {}, st = cfg.storage || {};
    const pc = lr.precheck || {}, at = lr.attribution || {}, mt = lr.meter || {}, tr = lr.trace || {}, fp = lr.fingerprint || {};
    const dur = (v) => (typeof v !== 'number' ? String(v) : v >= 1000 ? (v / 1000) + ' 秒' : v + ' 毫秒');
    const kb = (v) => (typeof v !== 'number' ? String(v) : (v / 1048576).toFixed(1) + ' MB');
    const row = (k, v, why) => '<tr><td>' + esc(k) + '</td><td class="mono">' + esc(String(v)) + '</td><td class="dim">' + esc(why || '') + '</td></tr>';

    const tierRows = Object.keys(pol.tiers || {}).map((id) => {
      const t = pol.tiers[id] || {};
      return '<tr><td class="mono">' + esc(id) + '</td><td>' + esc(t.label || '') + '</td><td>' + esc(t.precheck || '') +
        '</td><td>' + esc(t.attribution || '') + '</td><td class="mono">' + formatNumber(t.rpm) + '</td><td class="mono">' + formatNumber(t.maxConcurrency) +
        '</td><td>' + esc(t.billing || '') + '</td><td class="mono">' + (t.periodQuotaTokens ? formatNumber(t.periodQuotaTokens) : '不限') + '</td>' +
        // 周期预算(¥)列（manual#234）：auth-policy 早返回 tier.periodQuotaCny 但 GUI 从未消费——
        // 档位级 ¥ 预算设了却在面板上看不到（key 级预算在 keys 行/whoami 都显，#212/#216）。
        '</td><td class="mono">' + (t.periodQuotaCny != null ? cny(t.periodQuotaCny) : '不限') + '</td>' +
        // 智能路由列（manual#173）：auth-policy 早返回 tier.smartRouting 但 GUI 从未消费——
        // pro 层按价格选最便宜可用上游是档位间的实质能力差，选档位时应该看见。
        '<td>' + (t.smartRouting ? '<span class="chip g" title="按上游价格自动选最便宜可用者（P3 排序链）">智能路由</span>' : '<span class="dim">—</span>') + '</td></tr>';
    }).join('');

    // 开关行：data-lr="组.键"，保存时按这个路径回收勾选状态
    const sw = (path, key, on, label, why) =>
      '<label style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border2)">' +
      '<input type="checkbox" data-lr="' + path + '.' + key + '"' + (on ? ' checked' : '') + ' style="margin-top:3px">' +
      '<span><b>' + esc(label) + '</b><br><span class="dim" style="font-size:11px">' + esc(why) + '</span></span></label>';

    const retryOpts = [0, 1, 2, 3, 4, 5]
      .map((n) => '<option value="' + n + '"' + (Number(at.autoRetry) === n ? ' selected' : '') + '>' + n + ' 次</option>').join('');

    $('main').innerHTML = \`
      \${opsFail.length ? '<div class="note warn" style="margin-bottom:10px"><b>部分数据加载失败：</b>' + opsFail.map(esc).join('；') + '——对应区块显示的是空值而非真实配置，稍后点右上角 ↻ 重试。</div>' : ''}
      <div class="note"><b>这一页回答"网关现在到底按什么参数在跑"。</b>
        2026-09-14 两次误杀（首字节超时 30 秒、消息条数 512）都吃过同一个亏：<b>生效值只能去翻配置文件才看得见</b>。
        所以下面列的是<b>进程实际加载的值</b> —— 和文件里写的不一定一样（有的走环境变量覆盖）。</div>

      <section class="block"><h2>生效配置 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">来源 \${esc(cfg.sourcePath || '')}</span></h2>
        <table>
          <tr><th>项</th><th>生效值</th><th>它决定什么</th></tr>
          \${row('监听地址', sv.host + ':' + sv.port, '绑 :: 即双栈（IPv4 + IPv6 都收）')}
          \${row('首字节超时 TTFB', dur(sv.upstreamTtfbTimeoutMs), '上游这么久没吐第一个字节就换下一阶 —— 太小会误杀"慢但能成"的请求')}
          \${row('整条超时', dur(sv.upstreamTimeoutMs), '单次请求的总上限')}
          \${row('停摆超时', dur(sv.upstreamStallTimeoutMs), '回了响应头却不产出数据 → 按可重试处理（20 秒实测能挡住"假 200"）')}
          \${row('请求体上限', kb(sv.maxBodyBytes), '超过直接拒，不进上游')}
          \${row('关停宽限期', dur(sv.shutdownGraceMs), '收到停止信号后等多久让在途请求跑完再关——重启太快会在途请求被硬断')}
          \${row('消息条数上限', formatNumber(pc.maxMessages), '预检拦"太离谱"的请求；太小会误杀长轨迹评测')}
          \${row('工具条数上限', formatNumber(pc.maxTools), '同上')}
          \${row('预检动作', pc.onBlock || '', 'reject = 拦截；其余 = 只提醒放行')}
          \${row('存储', st.driver + ' · ' + st.path, '度量与轨迹落这里')}
          \${row('日志级别', cfg.logLevel || '', '')}
          \${row('模型别名', (() => {
            // 档位阶梯（manual#265）：此前读 cfg.modelAliases（旧机制恒空）——ops 页一直
            // 显示『无』而 7 个中文阶梯在服役。 ladder 是 fallback 链，渲染成 a → b → c。
            const ladders = cfg.modelLadders || cfg.modelAliases || {};
            const keys = Object.keys(ladders);
            if (!keys.length) return '无';
            const txt = keys.map((k) => k + ' → ' + (Array.isArray(ladders[k]) ? ladders[k].join(' → ') : ladders[k])).join('；');
            // 超长截断+title 全量（7 个阶梯+新 v2.6 入列后一整行放不下，ellipsis 防拉爆布局）
            return txt.length > 120 ? '<span title="' + esc(txt) + '">' + esc(txt.slice(0, 117)) + '…</span>' : esc(txt);
          })(), '请求模型名→实际模型链的映射（前者不可用自动落下一阶），排查路由错位时看这里')}
          \${row('管理令牌', sv.adminTokenSet ? '已设置' : '未设置（本机直连体验模式）', '未设置时 /admin 免令牌，只应出现在本机调试')}
          \${row('指纹脱敏', fp.enabled ? '开（阈值 ' + formatNumber(fp.agentThreshold, 2) + '）' : '关', 'A4 红线：请求指纹用 HMAC 截断，不落正文；关了对排障影响很大，不建议')}
          \${row('度量留存', (mt.retentionDays != null ? mt.retentionDays + ' 天' : '默认'), '清理范围<b>仅 meter（度量）+trace（轨迹）两表</b>——『上周的数据怎么没了』先看这里；更早的靠账本深搜兜底。每日按此天数自动清理（manual#319 兜底：启动时+每 24h 一次，删行记 storage.prune 审计事件；改天数热生效、下次清理生效）。<b>relay_event 运维事件表不在自动清理内</b>（manual#358 实证：prune 只删上述两表；事件表当前 ~1276 行 ≈0.4MB、增长慢，自动清理它是签字项——异常暴涨时手动 DELETE FROM relay_event WHERE ts &lt; 截止毫秒）')}
          \${row('trustProxy', String(sv.trustProxy), '当前无任何作用（保留字段）：网关不记录客户端 IP——meter 无 IP 列、限流按 key 归属、审计读 socket.remoteAddress')}
          \${row('公开只读端点', (sv.publicQuota ? '开' : '关') + ' / 允许远程 ' + (sv.publicQuotaRemote ? '开' : '关'), '/v1/quota 与 /v1/panel；默认只允许 127.0.0.1')}
        </table>
      </section>

      <section class="block"><h2>配置文件客户端 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">relay-net.yaml 里定义的 key——改了配置要重启才生效；面板动态创建的 key 在「客户 Key」页</span></h2>
        <table>
          <tr><th>id</th><th>label</th><th>key（脱敏）</th><th>档位</th><th>租户</th><th>状态</th></tr>
          \${(cfg.clients || []).length ? (cfg.clients || []).map((c) => '<tr><td class="mono">' + esc(c.id) + '</td><td>' + esc(c.label || '—') + '</td><td class="mono dim">' + esc(c.key || '—') + '</td><td>' + esc(c.tier || '—') + '</td><td class="mono dim">' + esc(c.tenantId || '—') + '</td><td>' + (c.enabled ? '<span class="chip g">启用</span>' : '<span class="chip r">停用</span>') + '</td></tr>').join('') : '<tr><td colspan="6" class="dim">无（配置里没有 clients 段）</td></tr>'}
        </table>
        <div class="note">配置来源的 key 只能停用不能彻底删除（删了重启还会回来，manual#306）——要下线请改 relay-net.yaml。</div>
      </section>

      <div class="grid two">
        <section class="block"><h2>降损层开关 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">precheck/attribution 热生效 · meter/trace 需重启</span></h2>
          <div>
            \${sw('precheck', 'enabled', pc.enabled, 'P2 预检', '畸形请求在上游之前拦下，省一次往返')}
            \${sw('attribution', 'enabled', at.enabled, 'P3 归因', '把上游错误翻译成可执行的下一步')}
            \${sw('attribution', 'includeEvidence', at.includeEvidence, '归因附证据', '错误体里附原始错误片段（更透明，响应也更大）')}
             \${sw('attribution', 'siblingModelFallback', at.siblingModelFallback, '阶梯兜底', '客户点名某个模型被限流时，横向换供应商耗尽后沿档位阶梯换同档模型（同厂姊妹优先），让任务跑完而不是丢 429 回去；关掉则退回单阶，429 直接回给客户端')}
            \${sw('meter', 'enabled', mt.enabled, 'P8 度量', 'token / 成本 / 延迟落库 —— 关了就没有账')}
            \${sw('trace', 'enabled', tr.enabled, 'P5 轨迹', '每个请求的阶段时间线，排障全靠它')}
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
            <span>可恢复错误自动重试 <select id="lr-retry">\${retryOpts}</select></span>
            <button id="lr-save">保存</button>
            <span class="dim" style="font-size:11px">⚠ precheck/attribution <b>热生效</b>；meter/trace 开关在进程启动时捕获，热改无效（保存时会分级提示）；所有开关重启后回到 relay-net.yaml 的值，永久改请改配置</span>
          </div>
        </section>
        <section class="block"><h2>分层策略</h2>
          <table>
            <tr><th>分层</th><th>名字</th><th>预检</th><th>归因</th><th>rpm</th><th>并发</th><th>计费</th><th>周期额度</th><th>周期预算(¥)</th><th>路由</th></tr>
            \${tierRows || '<tr><td colspan="10" class="dim">没有档位配置——检查 relay-net.yaml 的 tiers 段（没有档位所有 key 都会落默认档）</td></tr>'}
          </table>
          <div class="dim" style="font-size:11px;margin-top:8px">当前 \${formatNumber(pol.activeKeys)} / \${formatNumber(pol.keyCount)} 个 key 生效 · 额度周期 \${Math.round((pol.quotaPeriodMs || 0) / 86400000)} 天<br>\${esc(pol.note || '')}</div>
        </section>

        <section class="block"><h2>进化方向 <span class="spacer"></span><span class="dim" style="font-size:11px;text-transform:none">manual#372 · 手动设置，引擎每轮第 0 步读取</span></h2>
          <div class="note" style="margin:0 0 10px">网站由进化引擎逐轮推进。<b>这里可以手动指定下一轮方向</b>——设了就跑你选的，清空就回到引擎的候选队列自动排序（按杠杆率）。设置即时落盘（data/evolution-direction.json），引擎下一轮第 0 步读取并同步进长期目标。</div>
          <div id="evo-cur" style="margin-bottom:10px"></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="evo-next" style="min-width:280px">\${(evo.candidates || []).map((c) => '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>').join('')}</select>
            <input id="evo-note" placeholder="备注（可选，≤200 字：为什么要这个方向/约束条件）" style="flex:1;min-width:220px">
            <button id="evo-save">设为下一轮方向</button>
            <button class="bare" id="evo-clear">恢复自动</button>
          </div>
          <div class="dim" style="font-size:11px;margin-top:8px">下拉是引擎本轮的候选队列（驾驶舱 0.2）；也可以直接打字写自由文本。当前设置：<span id="evo-cur2" class="mono"></span></div>
          <div id="evo-hist" style="margin-top:10px"></div>
        </section>
      </div>

      <section class="block"><h2>文本报告 <span class="spacer"></span><button class="bare" id="rp-copy">复制</button><button class="bare" id="rp-load">↻ 加载</button></h2>
        <div class="dim" style="font-size:11px;margin-bottom:8px">同一份数据在命令行也能拿：<span class="mono">node dist/cli.js report --window \${win()}</span></div>
        <pre id="rp-body">（点右上角「加载」）</pre>
      </section>

      <section class="block"><h2>hermes 聚合站（8767）<span class="spacer"></span><span id="hx-st" style="font-size:11px"></span><a class="bare" href="http://127.0.0.1:8767/admin" target="_blank" rel="noopener">⧉ 新窗口打开</a></h2>
        <div class="dim" style="font-size:11px;margin-bottom:8px">把 hermes 管理面板整页嵌进来（跨域 iframe · 保留它自己的登录态）。渠道 / 用户 / 账本 / 度量都在框里操作；8767 的管理令牌在框内单独登一次（浏览器会记住）。</div>
        <div id="hx-box"></div>
      </section>\`;

    const evoRender = () => {
      const s = evo.setting || null;
      const hist = (evoLog.events || []).slice(0, 3);
      const histEl = $('evo-hist');
      if (histEl) {
        histEl.innerHTML = hist.length
          ? '<div class="dim" style="font-size:11px;margin-bottom:4px">最近变更（manual#379：设过什么、什么时候设的，不用翻事件页）</div>' +
            hist.map((e) => {
              const d = e.detail || {};
              const what = d.next ? '<span class="mono">' + esc(String(d.next)) + '</span>' + (d.note ? ' <span class="dim">' + esc(String(d.note)) + '</span>' : '') : '<span class="dim">恢复自动（按队列排序）</span>';
              return '<div style="font-size:11px" class="dim">' + new Date(e.ts).toLocaleString('zh-CN') + ' · ' + what + '</div>';
            }).join('')
          : '';
      }
      $('evo-cur').innerHTML = s
        ? '<b>当前手动方向：</b><span class="mono">' + esc(String(s.next)) + '</span>' + (s.note ? ' <span class="dim">—— ' + esc(String(s.note)) + '</span>' : '') +
          ' <span class="dim" style="font-size:11px">（' + (s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '?') + (s.updatedBy ? ' · ' + esc(String(s.updatedBy)) : '') + ' 设置）</span>'
        : '<span class="dim">当前未手动设置——按引擎候选队列自动排序（性能优先、白名单内可落项优先）。</span>';
      $('evo-cur2').textContent = s ? String(s.next) : '（自动）';
    };
    evoRender();
    $('evo-save').addEventListener('click', async () => {
      const next = $('evo-next').value.trim();
      const note = $('evo-note').value.trim();
      if (!next) { toast('先选一个方向（或在输入框写自由文本）', 'y'); return; }
      try {
        await api('evolution-direction', { method: 'POST', body: JSON.stringify({ next, note }) });
        toast('已设为下一轮方向：<b>' + esc(next) + '</b>——引擎下一轮第 0 步生效', 'g');
        evo.setting = { next, note, updatedAt: Date.now() }; evoRender();
      } catch (e) { const r = writeErr('设置进化方向', e); toast(r.text, r.tone); }
    });
    $('evo-clear').addEventListener('click', async () => {
      try {
        await api('evolution-direction', { method: 'POST', body: JSON.stringify({ clear: true }) });
        toast('已恢复自动排序——引擎按候选队列（杠杆率）推进', 'g');
        evo.setting = null; evoRender();
      } catch (e) { const r = writeErr('恢复自动', e); toast(r.text, r.tone); }
    });
    $('lr-save').addEventListener('click', async () => {
      const body = { precheck: {}, attribution: {}, meter: {}, trace: {} };
      $('main').querySelectorAll('[data-lr]').forEach((el) => {
        const parts = el.dataset.lr.split('.');
        body[parts[0]][parts[1]] = el.checked;
      });
      body.attribution.autoRetry = Number($('lr-retry').value);
      try {
        const r = await api('loss-reduction/update', { method: 'POST', body: JSON.stringify(body) });
        // 热生效性分级展示（manual#161）：后端按字段分级（引擎持引用热生效 vs Meter/TraceStore
        // 构造时捕获需重启）——meter/trace 的热改是静默无效的，必须让运营当场看到区别。
        const parts = ['已生效：' + esc((r.changed || []).join('、'))];
        if ((r.hot || []).length) parts.push('<span class="ok">热生效：' + esc((r.hot || []).join('、')) + '</span>');
        if ((r.needsRestart || []).length) parts.push('<span class="warn">需重启才生效（进程启动时捕获，热改无效）：' + esc((r.needsRestart || []).join('、')) + '——请改 relay-net.yaml 后重启</span>');
        parts.push('<span class="dim">' + esc(r.note || '') + '</span>');
        toast(parts.join('<br>'));
      } catch (e) {
        // writeErr 分类（manual#203）：#193 推广的漏网形状（catch 块跨行）——降损保存的
        // 400/404 是输入/状态问题（黄），5xx 才是系统故障（红）。
        const r = writeErr('保存降损开关', e);
        toast(r.text, r.tone);
      }
    });
    let rpLoaded = false;
    $('rp-load').addEventListener('click', async () => {
      try {
        const r = await api('report?window=' + win());
        $('rp-body').textContent = r.raw || '';
        rpLoaded = !!r.raw;
        if (!r.raw) toast('报告为空（窗口内无请求）', 'y');
      } catch (e) {
        toast('加载失败：' + esc(e.message), 'r');
      }
    });
    // 文本报告复制（manual#90）：报告是给用户/厂商的分享物——页面自己说"同一份数据命令行也能拿"，
    // 但 GUI 里只能手动选区。先加载再复制，空报告/未加载都给明确提示而非复制一串占位文本。
    $('rp-copy').addEventListener('click', () => {
      const body = $('rp-body');
      const text = body ? body.textContent : '';
      if (!rpLoaded || !text.trim()) return toast('先点「加载」生成报告', 'y');
      copyText(text, '文本报告已复制（window=' + win() + '）');
    });
    // hermes 聚合站（8767）存活探测（manual#85）：两站合并后此区块常驻运维页，
    // 但 8767 停机时 iframe 只显示浏览器错误页、不给任何解释——先探活再决定嵌不嵌。
    // 跨域 fetch 会被 CORS 挡，用 no-cors 只求可达性：可达=resolve(opaque)，拒连=reject。
    const hxProbe = async () => {
      const st = $('hx-st'), box = $('hx-box');
      if (!st || !box) return;
      st.textContent = '探测中…';
      let up = false;
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 3000);
        try { await fetch('http://127.0.0.1:8767/healthz', { mode: 'no-cors', signal: c.signal }); up = true; }
        finally { clearTimeout(t); }
      } catch { up = false; }
      if (up) {
        st.innerHTML = '<span class="chip g">运行中</span>';
        box.innerHTML = '<iframe src="http://127.0.0.1:8767/admin" style="width:100%;min-height:1050px;border:1px solid var(--border);border-radius:var(--r2);background:#0d1117"></iframe>';
      } else {
        st.innerHTML = '<span class="chip r">未运行</span>';
        box.innerHTML =
          '<div class="note warn"><b>聚合站 8767 当前未运行</b>，面板嵌入不可用（不是本页的问题）。<br>' +
          '排查：<span class="mono">ss -tlnp | grep 8767</span> 看监听；RelayGate 代码在 <span class="mono">~/文档/二转moa模型</span>；启动前需先验证 tokenrhythm key 与余额（重启门控）。' +
          '启动后点这里 <button class="bare" id="hx-retry">重试探测</button> 即可嵌入。</div>';
        const btn = $('hx-retry');
        if (btn) btn.addEventListener('click', hxProbe);
      }
    };
    hxProbe();
  }

  /* ---------------- 启动 ---------------- */
  const loadSiteVersion = async () => {
    try { const h = await fetch('/healthz'); const d = await h.json(); SITE_VERSION = d.version || ''; } catch { /* 取不到就不显示，不留裸 v */ }
    // 登录框版本位（manual#167）：登录态也可能停在这里（等运营输令牌）——版本就绪即回填。
    const lv = $('lver');
    if (lv) lv.textContent = SITE_VERSION ? '网关版本 v' + SITE_VERSION : '';
  };

  function boot() {
    nav();
    render();
    // 时钟 interval 先清再建（manual#142）：boot 在每次登录时都会跑（含 401 后重新登录），
    // 不清就会叠加——N 次重新登录 = N 个每秒回调（arm 的刷新 timer 一早就有清理，时钟漏了）。
    if (clockTimer) clearInterval(clockTimer);
    const freshAgo = (ms) => {
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + ' 秒前';
      const m = Math.floor(s / 60);
      if (m < 60) return m + ' 分钟前';
      return Math.floor(m / 60) + ' 小时前';
    };
    clockTimer = setInterval(() => {
      $('clock').textContent = new Date().toLocaleTimeString('zh-CN');
      const f = $('fresh');
      if (f && lastFresh) {
        const age = Date.now() - lastFresh;
        // 文本没变就不写（manual#304）：freshness 的文案是『数据 <取数时刻>（X 分钟前）』——
        // 取数时刻在两次刷新之间恒定、freshAgo 是分钟级，此前每秒重写同一文本 60 次
        // （每次都触发一次文本节点的无效替换）。颜色同理：只在越过 60s 阈值时换。
        const txt = '数据 ' + new Date(lastFresh).toLocaleTimeString('zh-CN') + '（' + freshAgo(age) + '）';
        if (f.textContent !== txt) f.textContent = txt;
        const wantColor = age > 60000 ? 'var(--err)' : '';
        if (f.style.color !== wantColor) f.style.color = wantColor;
      }
    }, 1000);
    $('clock').textContent = new Date().toLocaleTimeString('zh-CN');
    arm();
  }
  $('refresh').addEventListener('click', render);
  // 窗口选择持久化（manual#205）：运营盯着某个窗口干活（如 1h），此前每次刷新/重登
  // 都跳回 24h——视角丢失要重新选。localStorage 记忆（同令牌的存储方式）。
  try {
    const savedWin = localStorage.getItem('relay_admin_window');
    if (savedWin && $('win').querySelector('option[value="' + savedWin + '"]')) $('win').value = savedWin;
  } catch { /* 隐私模式等场景取不到就用默认 */ }
  $('win').addEventListener('change', () => {
    try { localStorage.setItem('relay_admin_window', $('win').value); } catch { /* 存不上不影响当次 */ }
    if (VIEW === 'ov' || VIEW === 'met') render();
  });

  let timer = null;
  let clockTimer = null;
  // 站点版本（manual#154）：/healthz 才有 version（overview/admin-health 都不返回）——
  // 此前 ov/指标两处直接读 ov.version/d.version，永远是 undefined，页头显示裸「v」。
  // boot 时取一次缓存，三处显示（页头×2+值班摘要）统一用它。
  let SITE_VERSION = '';
  function arm() {
    if (timer) clearInterval(timer);
    if (!$('auto').checked) return;
    // P5 修复：可配置刷新间隔
    let interval = 15000;
    try {
      const saved = localStorage.getItem('relay_admin_refresh');
      if (saved) interval = Number(saved) * 1000;
    } catch { /* 取不到就用默认 */ }
    // 只自动刷新"只读"页，避免正在填表单时被重置。
    // agent 进白名单（manual#135）：该页纯只读（状态+历史+触发按钮，无表单状态），
    // 但触发一次 Agent 运行后此前不自动刷新——toast 说"稍后刷新查看"，运营得手动刷
    // 才看到运行结果（LLM 一轮 10-20s，正好落在 15s 刷新间隔内）。
    // 在途闸（manual#345）：render() 是 async 而 setInterval 不等它——慢响应（fetch 30s
    // 超时）时下一个 tick 会叠加发起并发 render：多个 innerHTML 竞写（旧响应可能覆盖新
    // 响应=显示 stale 数据）+ 请求堆积。端点虽快（3-16ms），但上游卡住时 health/metrics
    // 会慢，闸门保证任意时刻只有一个 render 在途（跳过的 tick 由下一个 15s 补上，
    // 新鲜度只损失一个周期，换取不竞写不堆积）。
    let inflight = false;
    timer = setInterval(() => {
      if (['ov', 'met', 'ch', 'trust', 'agent'].includes(VIEW) && !$('drawer').classList.contains('on') && !document.hidden && !inflight) {
        inflight = true;
        Promise.resolve(render()).finally(() => { inflight = false; });
      }
    }, interval);
    // 后台标签页不刷新（manual#303）：面板常挂在后台标签页一整天——隐藏时每 15s 仍拉
    // 18.3KB（带宽/服务端 CPU/电池全浪费），而运营根本不在看。回到可见时立即刷一次
    // （不 stale）：跳过的是『没人看时的拉取』，不是『新鲜度』。
    if (!document.__relayVisHooked) {
      document.__relayVisHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && $('auto').checked && ['ov', 'met', 'ch', 'trust', 'agent'].includes(VIEW) && !$('drawer').classList.contains('on')) render();
      });
    }
  }
  $('auto').addEventListener('change', arm);

  // P5 修复：主题切换
  const applyTheme = (theme) => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('relay_admin_theme', theme);
    } catch { /* 隐私模式等场景忽略 */ }
  };
  try {
    const savedTheme = localStorage.getItem('relay_admin_theme');
    if (savedTheme) applyTheme(savedTheme);
  } catch { /* 取不到就用默认 */ }
  $('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(current);
  });

  // 语言切换（v406）：LANG 与 t() 已在视图表处定义，这里只负责切换后重刷界面
  const applyLang = (lang) => {
    LANG = lang === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('relay_admin_lang', LANG); } catch { /* 忽略 */ }
    // 重刷：页签文案 + 页头控件 + 当前页（页面正文里的按钮文案随 render 走）
    applyChrome();
    nav();
    render();
  };
  applyChrome();
  $('langToggle').addEventListener('click', () => {
    applyLang(LANG === 'zh' ? 'en' : 'zh');
  });

  // P5 修复：刷新间隔配置
  const applyRefreshInterval = (seconds) => {
    try { localStorage.setItem('relay_admin_refresh', String(seconds)); } catch { /* 忽略 */ }
    // 重新 arm 定时器
    arm();
  };
  try {
    const savedRefresh = localStorage.getItem('relay_admin_refresh');
    if (savedRefresh && $('refreshInterval')) $('refreshInterval').value = savedRefresh;
  } catch { /* 取不到就用默认 */ }
  $('refreshInterval').addEventListener('change', () => {
    applyRefreshInterval(Number($('refreshInterval').value));
  });

  // 首屏：先探测是否需要令牌
  // 启动链并行化（manual#315）：此前是三级串行——panel-info → overview 全量探测（令牌
  // 校验）→ healthz（版本）→ 才 boot 拉数据。本地白耗两个 RTT，远程（funnel/隧道）白耗
  // 两个完整往返。三个请求互不依赖（令牌校验用 TOK、版本用 /healthz），合并成一批并行；
  // 探测端点从 overview 换成 kb（491B vs overview 全量 summarize）——校验只需 401 与否。
  (async () => {
    try {
      const verP = loadSiteVersion();
      const probeP = TOK ? raw('kb').then(() => true, (e) => { if (e && e.status === 401) throw e; return true; }) : Promise.resolve(true);
      const [info, , probeOk] = await Promise.all([raw('panel-info'), verP, probeP]);
      if (!info.tokenRequired) { hideLogin(); boot(); }
      else if (TOK && probeOk) { hideLogin(); boot(); }
      else if (TOK) showLogin('令牌无效或已过期');
      else showLogin('该网关已启用管理令牌，请输入');
    } catch (e) {
      if (e.status === 401) showLogin('令牌无效或已过期');
      else showLogin('无法连接管理接口：' + esc(e.message));
    }
  })();
})();`;

let _appJsCache: string | null = null;
function appJs(): string {
  if (_appJsCache !== null) return _appJsCache;
  try {
    const fresh = createHash('sha256').update(APP_SRC, 'utf8').digest('hex') === DASHBOARD_APP_SHA;
    _appJsCache = fresh && DASHBOARD_APP_MIN.length > 1000 ? DASHBOARD_APP_MIN : APP_SRC;
  } catch {
    _appJsCache = APP_SRC; // 哈希/导入异常一律回落源码（fail-open 到正确的大页面）
  }
  return _appJsCache;
}

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>api-relay · 管理面板</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230d1117'/%3E%3Ctext x='16' y='23' font-size='17' text-anchor='middle'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
<style>
:root{
  /* 颜色沿用已验证 WCAG AA 的那套暗色（对比度 4.6~14.6:1，全部达标），只调整层次与用法 */
  --bg:#0d1117;--panel:#161b22;--panel2:#1b212a;--border:#30363d;--border2:#222831;
  --fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--err:#f85149;--pur:#bc8cff;
  --chip:#21262d;--focus:rgba(88,166,255,.45);
  /* 间距与圆角：统一成节奏，避免 13/9/7 这种手工值到处飞 */
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:22px;
  --r1:6px;--r2:10px;--r3:14px;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sh1:0 1px 2px rgba(0,0,0,.35);--sh2:0 10px 30px rgba(0,0,0,.45);
}
/* P5 修复：亮色主题 */
:root[data-theme="light"]{
  --bg:#f6f8fa;--panel:#ffffff;--panel2:#f0f2f5;--border:#d0d7de;--border2:#e5e8eb;
  --fg:#1f2328;--dim:#59636e;--accent:#0969da;--ok:#1a7f37;--warn:#9a6700;--err:#d1242f;--pur:#8250df;
  --chip:#eaeef2;--focus:rgba(9,105,218,.35);
  --sh1:0 1px 2px rgba(0,0,0,.08);--sh2:0 10px 30px rgba(0,0,0,.12);
}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent)}
/* 数字统一等宽对齐：表格里的金额/token/耗时能一列对齐，扫起来快很多 */
.mono,td.mono,.card .v,.hbar .vl,.kv .v,th{font-variant-numeric:tabular-nums}
input,select,button,textarea{font:inherit;background:var(--chip);color:var(--fg);border:1px solid var(--border);border-radius:var(--r1);padding:6px 10px;transition:border-color .12s,background .12s,box-shadow .12s}
input:hover,select:hover{border-color:#3d444d}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--focus)}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--accent)}
button:active{transform:translateY(1px)}
button.pri{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}
button.pri:hover{background:#2a7ff5;border-color:#2a7ff5}
button.danger{border-color:#6e2b28;color:#ff9d96}
button.danger:hover{background:#3d1d1b;border-color:var(--err)}
button.bare{background:none;border-color:transparent;color:var(--dim)}
button.bare:hover{background:var(--chip);border-color:transparent;color:var(--fg)}
button:disabled{opacity:.45;cursor:not-allowed;transform:none}

/* 登录门 */
#login{position:fixed;inset:0;background:radial-gradient(1000px 500px at 50% -10%,#16273d 0%,var(--bg) 60%);display:none;align-items:center;justify-content:center;z-index:80;padding:20px}
#login.on{display:flex}
#login .box{background:var(--panel);border:1px solid var(--border);border-radius:var(--r3);padding:28px;width:100%;max-width:392px;box-shadow:var(--sh2)}
#login h1{font-size:17px;margin-bottom:var(--s1)}
#login h1 em{color:var(--accent);font-style:normal}
#login p{color:var(--dim);margin-bottom:var(--s4);font-size:13px}
#login input{width:100%;margin-bottom:var(--s3);padding:9px 12px}
#login button{width:100%;padding:9px}
#lerr{color:var(--err);font-size:12px;min-height:17px;margin-top:var(--s2)}

header{display:flex;align-items:center;gap:var(--s3);padding:10px var(--s5);border-bottom:1px solid var(--border);
  background:rgba(22,27,34,.86);backdrop-filter:blur(8px);position:sticky;top:0;z-index:20;flex-wrap:wrap}
header .logo{font-weight:700;white-space:nowrap;letter-spacing:.01em}
header .logo em{color:var(--accent);font-style:normal;font-weight:600}
header .sub{color:var(--dim);font-size:12px;display:inline-flex;align-items:center;gap:6px;min-height:30px;cursor:pointer}
header .sub input[type=checkbox]{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--accent)}
header .spacer{flex:1}
nav{display:flex;gap:var(--s1);flex-wrap:wrap;background:var(--chip);padding:3px;border-radius:calc(var(--r1) + 3px);border:1px solid var(--border2)}
nav button{background:none;border:none;color:var(--dim);padding:6px 13px;border-radius:var(--r1);font-size:13px;transition:color .12s,background .12s}
nav button:hover{color:var(--fg);background:#2a313a}
nav button.on{background:var(--panel);color:var(--fg);font-weight:600;box-shadow:var(--sh1)}
main{padding:var(--s5) var(--s5) 80px;max-width:1200px;margin:0 auto;transition:opacity .12s}
main.loading{opacity:.5;pointer-events:none}
/* P4 修复：loading 提示样式 */
.loading-tip{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--panel);color:var(--fg);padding:12px 24px;border-radius:var(--r2);font-size:14px;box-shadow:var(--sh2);z-index:1000;pointer-events:none}

.grid{display:grid;gap:var(--s3)}
.cards{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.two{grid-template-columns:1.3fr 1fr}
@media(max-width:1020px){.two{grid-template-columns:1fr}}
.card,section.block{background:var(--panel);border:1px solid var(--border);border-radius:var(--r2);padding:var(--s4);min-width:0;transition:border-color .14s}
.card:hover{border-color:#3d444d}
section.block{margin-top:var(--s4);overflow-x:auto}
/* 极窄屏时表格可横向滚动，而不是把整页撑出横向滚动条 */
.card{overflow-x:auto}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:#30363d;border-radius:99px;border:2px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:#3d444d;background-clip:content-box}
*::-webkit-scrollbar-track{background:transparent}
.empty{display:flex;flex-direction:column;align-items:center;gap:var(--s2);padding:var(--s5);color:var(--dim);font-size:13px;text-align:center}
.empty .ic{font-size:22px;opacity:.6}
.card .k{color:var(--dim);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h2{color:var(--fg);font-size:13px;font-weight:600;letter-spacing:0;display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s3);text-transform:none}
h2:before{content:"";width:3px;height:13px;border-radius:2px;background:var(--accent);flex:none}
h2 .spacer{flex:1}
.card .v{font-size:23px;font-weight:650;margin-top:var(--s1);font-family:var(--mono);letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .sub{font-size:11px;color:var(--dim);margin-top:var(--s3);border-top:1px dashed var(--border);padding-top:var(--s2)}

table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--dim);text-align:left;font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:10px var(--s3);border-bottom:1px solid var(--border);white-space:nowrap;background:var(--panel)}
td{padding:11px var(--s3);border-bottom:1px solid var(--border2);vertical-align:middle}
td.mono,.mono{font-family:var(--mono);font-size:12px}
tbody tr:hover{background:var(--panel2)}
tr.click:hover{background:var(--panel2);cursor:pointer}
tr:last-child td{border-bottom:none}
td.act{text-align:right;white-space:nowrap}
td.act button{padding:3px 9px;font-size:12px;margin-left:var(--s1)}
td.num,th.num{text-align:right}

.chip{display:inline-flex;align-items:center;gap:5px;background:var(--chip);border:1px solid var(--border);border-radius:999px;
  padding:1px 9px;font-size:12px;line-height:1.7;white-space:nowrap;cursor:default;color:var(--dim)}
.chip:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85;flex:none}
.chip.b{color:var(--accent);border-color:#1f6feb;background:rgba(31,111,235,.12)}
.chip.g{color:var(--ok);border-color:#2b6a35;background:rgba(63,185,80,.12)}
.chip.y{color:var(--warn);border-color:#5c4a12;background:rgba(210,153,34,.12)}
.chip.r{color:var(--err);border-color:#6e2b28;background:rgba(248,81,73,.12)}
.chip
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}.dim{color:var(--dim)}
.row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin-bottom:var(--s3)}
.filters{display:flex;gap:var(--s1);flex-wrap:wrap}
.filters button{padding:4px 11px;font-size:12px}
.filters button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}

.bars{display:flex;align-items:flex-end;gap:3px;height:96px;padding-top:var(--s2)}
.bars .b{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:3px;min-width:0}
.bars-axis{display:flex;gap:3px;margin-top:2px}
.bars-axis span{flex:1;text-align:center;font-size:10px;color:var(--dim);font-family:var(--mono);overflow:hidden;white-space:nowrap;min-width:0}
.fill{width:100%;background:linear-gradient(180deg,var(--accent),#1f6feb);border-radius:3px 3px 0 0;min-height:2px;transition:height .2s}
.bars 
.bars .fill.f{background:linear-gradient(180deg,var(--err),#8b1f1a)}
.hbar{display:flex;align-items:center;gap:var(--s2);margin:7px 0;font-size:12px}
.hbar .nm{width:170px;color:var(--dim);font-family:var(--mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar .track{flex:1;height:8px;background:var(--chip);border-radius:99px;overflow:hidden;min-width:40px}
.hbar .in{height:100%;background:var(--accent);border-radius:99px;transition:width .2s}
.hbar .in.y{background:var(--warn)}.hbar .in.r{background:var(--err)}.hbar .in.g{background:var(--ok)}
.hbar .vl{width:150px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;text-align:right;font-family:var(--mono);font-size:11px;color:var(--fg)}

pre{background:#0b0f14;border:1px solid var(--border);border-radius:var(--r2);padding:var(--s3);font-size:12px;overflow:auto;max-height:460px;white-space:pre-wrap;word-break:break-all;font-family:var(--mono)}
.kv{display:grid;grid-template-columns:170px 1fr;gap:7px var(--s3);font-size:13px}
.kv .k{color:var(--dim)}
.steps{font-family:var(--mono);font-size:12px}
.step{display:grid;grid-template-columns:66px 40px 1fr;gap:var(--s2);padding:4px 0;border-bottom:1px dashed var(--border2)}
.step .y{color:var(--ok)}.step .n{color:var(--err)}

.note{border:1px solid var(--border);background:var(--panel);border-radius:var(--r2);padding:var(--s3) var(--s4);font-size:12px;color:var(--dim);margin-bottom:var(--s3);line-height:1.65}
.note b{color:var(--fg)}
.note.warn{border-color:#5c4a12;background:#211c0d}
.note.bad{border-color:#5c2a12;background:#1f0f0d}
.note
.inv{border-left:3px solid var(--accent);padding:var(--s2) 0 var(--s2) var(--s3);margin-bottom:var(--s3)}
.inv b{display:block;margin-bottom:2px}
.inv .t{color:var(--dim);font-size:12px}
.inv .ev{margin-top:var(--s2);font-family:var(--mono);font-size:11px;color:var(--ok)}

/* 右侧抽屉 */
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(580px,94vw);background:var(--panel);border-left:1px solid var(--border);
transform:translateX(100%);transition:transform .22s cubic-bezier(.22,.61,.36,1);z-index:60;display:flex;flex-direction:column;box-shadow:-18px 0 44px rgba(0,0,0,.5)}
#drawer.on{transform:none}
#drawer .dh{display:flex;align-items:center;gap:var(--s3);padding:14px var(--s4);border-bottom:1px solid var(--border)}
#drawer .dh b{font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#drawer .db{padding:var(--s4);overflow:auto;flex:1}
#drawer .df{padding:var(--s3) var(--s4);border-top:1px solid var(--border);display:flex;gap:var(--s2);justify-content:flex-end}
#scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:55;display:none}
#scrim.on{display:block}

#toast{position:fixed;bottom:var(--s5);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:var(--s2);align-items:center;z-index:90;pointer-events:none;max-width:calc(100vw - 24px)}
#toast div{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--r2);padding:10px 15px;font-size:12px;max-width:560px;box-shadow:var(--sh2)}
#toast div.g{border-left-color:var(--ok)}#toast div.y{border-left-color:var(--warn)}#toast div.r{border-left-color:var(--err)}
.secret{background:#0b0f14;border:1px solid var(--warn);border-radius:var(--r2);padding:var(--s3);font-family:var(--mono);font-size:13px;word-break:break-all;user-select:all}
.f{display:grid;grid-template-columns:130px 1fr;gap:var(--s2) var(--s3);align-items:center;margin-bottom:var(--s2)}
.f label{color:var(--dim);font-size:12px}
.f input,.f select,.f textarea{width:100%}

</style>
</head>
<body>

<!-- 登录门 -->
<div id="login">
  <div class="box">
    <h1>⚡ api-relay <em data-i18n="panel">管理面板</em></h1>
    <p data-i18n="loginHint">输入管理令牌登录（仅保存在本浏览器 localStorage）</p>
    <input id="tok" type="password" placeholder="admin token" autocomplete="off">
    <button class="pri" id="dologin" data-i18n="login">登录</button>
    <div id="lerr"></div>
    <div class="dim" style="font-size:11px;margin-top:10px" id="lver"></div>
    <div class="dim" style="font-size:11px;margin-top:12px;line-height:1.7">令牌在网关配置的 <span class="mono">adminToken</span>（或环境变量 <span class="mono">RELAY_ADMIN_TOKEN</span>）——部署者在启动网关时设定；忘了就只能改配置重启网关，面板本身不提供找回（服务端只存校验、不存明文）。</div>
  </div>
</div>

<header>
  <span class="logo">⚡ api-relay <em data-i18n="panel">管理面板</em></span>
  <nav id="nav"></nav>
  <span class="spacer"></span>
  <span class="sub" id="ver">—</span>
  <span class="sub" id="clock"></span>
  <span class="sub" id="fresh" title="最后一次成功加载数据的时间；超过 60 秒未更新会变红（自动刷新失败或已关闭）">—</span>
  <label class="sub"><span data-i18n="win">窗口</span>
    <select id="win" data-i18n-opt="w5m,w1h,w24h,w7d,w30d">
      <option value="5m">5 分钟</option><option value="1h">1 小时</option>
      <option value="24h" selected>24 小时</option><option value="7d">7 天</option><option value="30d">30 天</option>
    </select>
  </label>
  <label class="sub"><input type="checkbox" id="auto" checked> <span data-i18n="autoRefresh">自动刷新</span></label>
  <label class="sub"><span data-i18n="refreshEvery">刷新间隔</span>
    <select id="refreshInterval" data-i18n-opt="s5,s15,s30,s60">
      <option value="5">5 秒</option>
      <option value="15" selected>15 秒</option>
      <option value="30">30 秒</option>
      <option value="60">60 秒</option>
    </select>
  </label>
  <button class="bare" id="themeToggle" data-i18n-title="themeTip" title="切换主题（暗色/亮色）">🌓</button>
  <button class="bare" id="langToggle" data-i18n-title="langTip" title="切换语言（中/EN）">🌐</button>
  <button class="bare" id="refresh" data-i18n-title="refresh" title="刷新">↻</button>
  <button class="bare" id="logout" data-i18n="logout">退出</button>
</header>

<main id="main"></main>

<div id="scrim"></div>
<aside id="drawer">
  <div class="dh"><b id="dt"></b><button class="bare" id="dclose">关闭</button></div>
  <div class="db" id="dbody"></div>
  <div class="df" id="dfoot"></div>
</aside>
<div id="toast"></div>

<script>${appJs()}</script>
</body>
</html>`;
}
