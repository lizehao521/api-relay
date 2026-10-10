import React from 'react'

/**
 * api-relay 用量面板（Hermes 网页版 / 桌面端 UI 插件）
 *
 * 契约来自 hermes-plugin-authoring：
 *   export default { id, name, register(sdk) }
 *   sdk.register({ id, area, title, data: { placement, width }, render })
 *   有效 area: 'panes' | 'sidebar.nav' | 'statusBar.left|right' | 'routes' | 'palette'
 *   · 必须 import React；用 React.useState；用 React.createElement（不用 JSX）
 *   · 文件夹名必须等于 id
 *
 * 它做什么：把 api-relay 网关的用量读进来，显示
 *   ① 5 小时滚动窗口内的高速额度（上限 1500，超出即低速档）
 *   ② 下一次额度释放的倒计时（滚动窗口，不是整点重置）
 *   ③ 本窗口请求 / 失败 / token / 成本估计
 *   ④ 上游健康（agnes 是否熔断）
 * 这既是给"专业开发"用的运维面板，也是你自己用量的流水记录。
 *
 * 数据来源（按顺序尝试，第一个成功就用它）：
 *   1. 设置里的 relay 地址（localStorage: relayQuotaUrl），默认 http://127.0.0.1:8787/v1/quota
 *   2. 手动粘贴的 JSON 快照（页面内输入框）——有些浏览器会因 CORS 拦掉 localhost 请求，
 *      这种情况下把下面这条命令的输出贴进来即可：
 *        curl -s http://127.0.0.1:8787/v1/quota
 */

const PLUGIN_ID = 'relay-quota'
const LIMIT = 1500
const WINDOW_MS = 5 * 60 * 60 * 1000
const DEFAULT_URL = 'http://127.0.0.1:8787/v1/quota'

const S = {
  wrap: { padding: '10px 12px', fontSize: 12, lineHeight: 1.65, overflowY: 'auto', height: '100%' },
  row: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  big: { fontSize: 18, fontWeight: 700 },
  dim: { opacity: 0.65 },
  track: { height: 9, background: 'rgba(127,127,127,0.25)', borderRadius: 5, overflow: 'hidden', margin: '8px 0 10px' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 },
  cell: { border: '1px solid rgba(127,127,127,0.3)', borderRadius: 7, padding: '6px 8px' },
  k: { fontSize: 10.5, opacity: 0.6 },
  v: { fontSize: 14, fontWeight: 600 },
  btn: {
    padding: '3px 10px',
    cursor: 'pointer',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.45)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  input: {
    width: '100%',
    padding: '4px 7px',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.45)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 11,
    marginBottom: 6,
  },
  area: {
    width: '100%',
    minHeight: 54,
    padding: '5px 7px',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.45)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 11,
  },
  err: { color: '#f85149', fontWeight: 600 },
  ok: { color: '#3fb950' },
  warn: { color: '#d29922' },
}

function fmtDur(ms) {
  if (!isFinite(ms) || ms <= 0) return '现在'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h <= 0) return m + ' 分钟'
  return h + ' 小时 ' + m + ' 分钟'
}

function pickWindow(data, hours) {
  const ws = data && data.windows ? data.windows : []
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].windowHours === hours) return ws[i]
  }
  return null
}

function pickProvider(data, id) {
  const ps = data && data.providers ? data.providers : []
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].id === id) return ps[i]
  }
  return null
}

function RelayQuotaPanel() {
  const [state, setState] = React.useState({ loading: true, data: null, error: null })
  const [url, setUrl] = React.useState(function () {
    try {
      return window.localStorage.getItem('relayQuotaUrl') || DEFAULT_URL
    } catch (e) {
      return DEFAULT_URL
    }
  })
  const [pasted, setPasted] = React.useState('')
  const [showPaste, setShowPaste] = React.useState(false)

  const applySnapshot = function (json) {
    if (!json || typeof json !== 'object') {
      setState({ loading: false, data: null, error: '快照不是 JSON 对象' })
      return
    }
    setState({ loading: false, data: json, error: null })
  }

  const load = function () {
    setState({ loading: true, data: null, error: null })
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (json) {
        applySnapshot(json)
      })
      .catch(function (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        setState({
          loading: false,
          data: null,
          error: '读不到网关：' + msg + '（网关没起，或被浏览器 CORS 拦了——用下面的「粘贴快照」）',
        })
      })
  }

  React.useEffect(function () {
    let alive = true
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (json) {
        if (alive) applySnapshot(json)
      })
      .catch(function (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        if (alive) {
          setState({
            loading: false,
            data: null,
            error: '读不到网关：' + msg,
          })
        }
      })
    return function () {
      alive = false
    }
  }, [url])

  const saveUrl = function () {
    try {
      window.localStorage.setItem('relayQuotaUrl', url)
    } catch (e) {
      /* 忽略：隐私模式下写不了 localStorage */
    }
    load()
  }

  const header = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
    React.createElement('div', { style: { fontWeight: 700 } }, 'api-relay 用量'),
    React.createElement('div', { style: { flex: 1 } }),
    React.createElement('button', { style: S.btn, onClick: load }, '刷新'),
    React.createElement(
      'button',
      { style: S.btn, onClick: function () { setShowPaste(!showPaste) } },
      showPaste ? '收起' : '粘贴快照',
    ),
  )

  if (state.loading) {
    return React.createElement('div', { style: S.wrap }, header, React.createElement('div', { style: S.dim }, '正在读取…'))
  }

  if (state.error) {
    return React.createElement(
      'div',
      { style: S.wrap },
      header,
      React.createElement('div', { style: S.err }, '读不到数据'),
      React.createElement('div', { style: S.dim }, state.error),
      React.createElement('div', { style: { marginTop: 8 } },
        React.createElement('div', { style: S.k }, '网关地址'),
        React.createElement('input', { style: S.input, value: url, onChange: function (e) { setUrl(e.target.value) } }),
        React.createElement('button', { style: S.btn, onClick: saveUrl }, '保存并重试'),
      ),
      React.createElement('div', { style: { marginTop: 10 } },
        React.createElement('div', { style: S.k }, '或者在终端跑这条，把输出粘到下面'),
        React.createElement('div', { style: { ...S.dim, fontFamily: 'monospace', fontSize: 10.5, marginBottom: 4 } },
          'curl -s ' + url),
        React.createElement('textarea', {
          style: S.area,
          value: pasted,
          placeholder: '粘贴 /v1/quota 的 JSON',
          onChange: function (e) { setPasted(e.target.value) },
        }),
        React.createElement('button', {
          style: { ...S.btn, marginTop: 4 },
          onClick: function () {
            try {
              applySnapshot(JSON.parse(pasted))
            } catch (e) {
              setState({ loading: false, data: null, error: '粘贴的内容不是合法 JSON' })
            }
          },
        }, '用这份快照'),
      ),
    )
  }

  const d = state.data
  const w5 = pickWindow(d, 5) || { requests: 0, errors: 0, totalTokens: 0, costCny: 0, nextReleaseAt: 0 }
  const w1 = pickWindow(d, 1) || { requests: 0 }
  const w24 = pickWindow(d, 24) || { requests: 0 }

  const used = Number(w5.requests) || 0
  const left = LIMIT - used > 0 ? LIMIT - used : 0
  const exhausted = used >= LIMIT
  const pct = used / LIMIT > 1 ? 100 : Math.round((used / LIMIT) * 1000) / 10
  const barColor = exhausted ? '#f85149' : pct > 80 ? '#d29922' : '#3fb950'
  const releaseIn = w5.nextReleaseAt > 0 ? w5.nextReleaseAt - Date.now() : 0
  const agnes = pickProvider(d, 'agnes')

  return React.createElement(
    'div',
    { style: S.wrap },

    React.createElement(
      'div',
      { style: S.row },
      React.createElement('div', { style: { ...S.big, color: exhausted ? '#f85149' : '#3fb950' } }, exhausted ? '低速档' : '高速档'),
      React.createElement('div', { style: S.dim }, used + ' / ' + LIMIT + ' 次 · 5 小时滚动'),
    ),

    React.createElement(
      'div',
      { style: S.dim },
      exhausted
        ? '高速额度已满，新请求走低速。最早一批 ' + fmtDur(releaseIn) + ' 后释放。'
        : '还剩 ' + left + ' 次高速额度；最早一次 ' + fmtDur(releaseIn) + ' 后滚出窗口。',
    ),

    React.createElement('div', { style: S.track },
      React.createElement('div', { style: { width: pct + '%', height: '100%', background: barColor } })),

    React.createElement(
      'div',
      { style: S.grid },
      cell('本窗口请求', String(used)),
      cell('失败', String(Number(w5.errors) || 0)),
      cell('Token', String(Number(w5.totalTokens) || 0)),
      cell('成本(估)', '¥' + (Number(w5.costCny) || 0).toFixed(3)),
    ),

    React.createElement(
      'div',
      { style: { ...S.cell, marginBottom: 10 } },
      React.createElement('div', { style: S.k }, '其他窗口'),
      React.createElement('div', null, '1 小时 ' + (Number(w1.requests) || 0) + ' 次 · 24 小时 ' + (Number(w24.requests) || 0) + ' 次'),
    ),

    React.createElement(
      'div',
      { style: { marginBottom: 8 } },
      React.createElement(
        'div',
        null,
        '上游 agnes：',
        React.createElement(
          'span',
          { style: agnes ? (agnes.disabled || agnes.breakerOpen ? S.err : agnes.healthy ? S.ok : S.warn) : S.dim },
          agnes
            ? (agnes.disabled ? '已摘除' : agnes.breakerOpen ? '熔断中' : agnes.healthy ? '正常' : '异常')
            : '不在上游列表里',
        ),
        agnes ? React.createElement('span', { style: S.dim }, '（延迟 ' + agnes.ewmaLatencyMs + 'ms）') : null,
      ),
      React.createElement('div', { style: S.dim }, '网关运行 ' + Math.round(Number(d.uptimeS) || 0) + ' 秒 · 存储 ' + (d.store && d.store.ok ? '正常' : '不可用')),
    ),

    React.createElement(
      'div',
      { style: { ...S.dim, fontSize: 10.5, marginBottom: 8 } },
      '按网关收到的请求计数，不是厂商侧余额（厂商响应头里没有额度字段，查不到）。阈值 ' + LIMIT + ' 次 / ' + (WINDOW_MS / 3600000) + ' 小时。',
    ),

    React.createElement(
      'div',
      null,
      React.createElement('div', { style: S.k }, '网关地址'),
      React.createElement('input', { style: S.input, value: url, onChange: function (e) { setUrl(e.target.value) } }),
      React.createElement('button', { style: S.btn, onClick: saveUrl }, '保存'),
    ),
  )
}

function cell(k, v) {
  return React.createElement(
    'div',
    { style: S.cell, key: k },
    React.createElement('div', { style: S.k }, k),
    React.createElement('div', { style: S.v }, v),
  )
}

export default {
  id: PLUGIN_ID,
  name: 'api-relay 用量面板',
  register(sdk) {
    sdk.register({
      id: 'pane',
      area: 'panes',
      title: 'relay 用量',
      data: { placement: 'right', width: '320px' },
      render: function () {
        return React.createElement(RelayQuotaPanel)
      },
    })
  },
}
