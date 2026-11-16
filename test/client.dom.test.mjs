// DOM harness for the session-broadcast dialog.
//
// Runs the shipped client bundle inside jsdom with a stubbed module loader, a
// stubbed Client Session catalog, and a stubbed Session Controller, then drives
// the real React components: opening the dialog from the toolbar button, the
// catalog rows and tags, filtering, selection, queued delivery, per-target
// failures, and retrying only the failures.
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// React's DOM renderer reads `window`/`document` globals, so install jsdom
// before importing it.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:56696/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const h = React.createElement

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.error('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
}

async function waitFor(probe, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A small snapshot store shaped like the Client's `createSnapshotStore`. */
function createStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/** Build one catalog row the way `ClientSessions.projectList` does. */
function row(id, extra = {}) {
  return {
    id,
    displayTitle: extra.title ?? id,
    running: false,
    retainedBy: {},
    blank: false,
    updatedAt: 1_000,
    ...extra,
  }
}

function catalog(rows) {
  return {
    ids: rows.map((entry) => entry.id),
    byId: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

/** Minimal locale table renderer matching the Client's `{name}` interpolation. */
function translator(dict) {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

/** Set a controlled field's value the way a user typing would. */
function type(node, value) {
  const proto = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value)
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

/** Box payload matching what dsh-session-boxes stores and serves. */
const DEFAULT_BOXES = {
  boxes: [
    { id: 'box-work', name: '插件制作', color: 'green', parentId: null, order: 0 },
    { id: 'box-sub', name: '群发', color: 'cyan', parentId: 'box-work', order: 1 },
    { id: 'box-ru', name: '俄语', color: 'blue', parentId: null, order: 2 },
  ],
  memberships: {
    's-a': ['box-ru'],
    's-b': ['box-work'],
    's-c': ['box-sub'],
  },
}

/** Load the client bundle with stubs; return the slots, ctx, and delivery log. */
function loadPlugin(options = {}) {
  let registration = null
  dom.window.__ModuleLoader__ = {
    load(options) {
      registration = options.factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected module: ' + name)
      })
      registration.id = options.id
    },
  }
  // Run the bundle against the jsdom window.
  new dom.window.Function('window', 'document', SOURCE)(dom.window, dom.window.document)

  const boxes = options.boxes === undefined ? DEFAULT_BOXES : options.boxes
  dom.window.fetch = async () => {
    if (boxes === 'fail') throw new Error('the box plugin is not installed')
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, state: boxes }
      },
    }
  }

  const dicts = {}
  const slotEntries = []
  const deliveries = []
  const effects = []
  const rows = [
    row('s-a', { title: 'Russian grammar', cwd: 'D:\\work\\russian', updatedAt: 3_000 }),
    row('s-b', { title: 'Court book', cwd: 'D:\\work\\court', running: true, updatedAt: 4_000 }),
    row('s-c', { title: 'Card deck', cwd: 'D:\\work\\cards', blank: true, updatedAt: 2_000 }),
    row('s-d', { title: 'Reader', cwd: 'D:\\work\\cards', origin: 'subagent', parentId: 's-c', updatedAt: 1_000 }),
  ]
  const sessions = {
    list: createStore(catalog(rows)),
    async using(id, options, operation) {
      if (options === undefined || typeof options !== 'object') throw new Error('using needs options')
      if (options.source !== 'broadcast') throw new Error('unexpected source ' + String(options.source))
      const session = {
        async prompt(content, mode) {
          deliveries.push({ id, mode, content })
          if (id === 's-b') return { ok: false, error: { code: 'session/agent-busy', message: 'still busy' } }
          return { ok: true, value: { accepted: true } }
        },
      }
      return operation({ sessionId: id, binding: { session } })
    },
  }
  const workspaces = createStore({
    phase: 'ready',
    items: [
      { id: 'w1', title: 'Russian', sessionIds: ['s-a'] },
      { id: 'w2', title: 'Court', sessionIds: ['s-b'] },
      { id: 'w3', title: 'Cards', sessionIds: ['s-c', 's-d'] },
    ],
  })

  const services = { sessions, workspaces: { list: workspaces } }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(_ns, table) {
        Object.assign(dicts, table)
      },
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(entry, component) {
        slotEntries.push({ entry, component })
        return () => {}
      },
    },
  }

  registration.apply(ctx)
  return { slotEntries, ctx, deliveries, dicts, effects, sessions, workspaces }
}

/** Render the toolbar button and the dialog into one host element. */
function mount(loaded) {
  const button = loaded.slotEntries.find((slot) => slot.entry.id === 'session-broadcast-button')
  const overlay = loaded.slotEntries.find((slot) => slot.entry.id === 'session-broadcast-dialog')
  if (button === undefined || overlay === undefined) throw new Error('both slot registrations must exist')
  const t = translator(loaded.dicts.zh ?? {})
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(h(React.Fragment, null,
    h(button.component, { t }),
    h(overlay.component, { t, ...overlay.entry.inject() }),
  ))
  return { host, root }
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

console.log('session-broadcast: plugin registration')
{
  const loaded = loadPlugin()
  const names = loaded.slotEntries.map((slot) => slot.entry.name)
  check('registers composer toolbar button', names.includes('conversation.input.left'))
  check('registers overlay dialog', names.includes('shell.overlay'))
  check('dictionaries carry zh and en', typeof loaded.dicts.zh?.['dialog.title'] === 'string' && typeof loaded.dicts.en?.['dialog.title'] === 'string')
  check('styles injected', document.head.querySelector('[data-plugin-css="dsh-session-broadcast/SessionBroadcast.css"]') !== null)
  const css = document.head.querySelector('[data-plugin-css="dsh-session-broadcast/SessionBroadcast.css"]').textContent
  const selectors = css
    .split('}')
    .map((part) => part.split('{')[0].trim())
    .filter((selector) => selector !== '')
    .flatMap((selector) => selector.split(',').map((one) => one.trim()))
  check('every rule is scoped to the sbc- prefix', selectors.every((selector) => selector.startsWith('.sbc-')),
    selectors.filter((selector) => !selector.startsWith('.sbc-')).join(' | '))
  check('primary action uses the blue brand token',
    /\.sbc-btn\.is-primary\{[^}]*--dsw-alias-brand-primary-new-color/.test(css))
  check('primary action does not paint on the theme foreground token',
    !/\.sbc-btn\.is-primary\{[^}]*background:var\(--dsw-alias-brand-primary\)/.test(css))
  loaded.effects.forEach((effect) => effect.dispose?.())
}

console.log('session-broadcast: picker and delivery')
{
  const loaded = loadPlugin()
  const { host } = mount(loaded)
  check('dialog starts closed', host.querySelector('.sbc-dialog') === null)

  await waitFor(() => host.querySelector('button.sbc-tool'), 'toolbar button')
  const button = host.querySelector('button.sbc-tool')
  check('toolbar button renders', button !== null)
  check('button carries a label', button.getAttribute('aria-label') === '群发消息到多个会话')
  button.click()
  await waitFor(() => host.querySelector('.sbc-dialog'), 'dialog to open')

  const rows = [...host.querySelectorAll('.sbc-row')]
  check('every catalog session listed', rows.length === 4, String(rows.length))
  check('running session sorts first', rows[0].textContent.includes('Court book'), rows[0].textContent)
  check('running tag rendered', rows[0].textContent.includes('运行中'))
  check('subagent tag rendered', rows.some((row) => row.textContent.includes('子代理')))
  check('new-session tag rendered', rows.some((row) => row.textContent.includes('新会话')))
  check('workspace label shown', rows.some((row) => row.textContent.includes('Cards')))
  check('nothing preselected', host.querySelectorAll('.sbc-row.is-checked').length === 0)
  check('send disabled without text and targets', host.querySelector('.sbc-btn.is-primary').disabled === true)

  // Filter narrows the list.
  const search = host.querySelector('input.sbc-search')
  type(search, 'cour')
  await waitFor(() => host.querySelectorAll('.sbc-row').length === 1, 'filtered list')
  check('filter matches title', host.querySelector('.sbc-row').textContent.includes('Court book'))
  type(search, '')
  await waitFor(() => host.querySelectorAll('.sbc-row').length === 4, 'list restored')

  // Select all filtered rows, then drop the subagent target by title.
  host.querySelectorAll('.sbc-mini')[0].click()
  await waitFor(() => host.querySelectorAll('.sbc-row.is-checked').length === 4, 'select all')
  check('count reports four selected', host.textContent.includes('已选 4 个会话'), host.querySelector('.sbc-count').textContent)
  const rowFor = (title) => [...host.querySelectorAll('.sbc-row')].find((node) => node.textContent.includes(title))
  rowFor('Reader').querySelector('.sbc-check').click()
  await waitFor(() => host.querySelectorAll('.sbc-row.is-checked').length === 3, 'uncheck one')

  const text = host.querySelector('textarea.sbc-text')
  type(text, '  hello team  ')
  await waitFor(() => host.querySelector('.sbc-btn.is-primary').disabled === false, 'send enabled')
  host.querySelector('.sbc-btn.is-primary').click()

  await waitFor(() => host.querySelector('.sbc-results') !== null, 'results', 8_000)
  check('one delivery per selected session', loaded.deliveries.length === 3, String(loaded.deliveries.length))
  check('delivery mode is queue', loaded.deliveries.every((call) => call.mode === 'queue'))
  check('content is one trimmed text part',
    loaded.deliveries.every((call) => call.content.length === 1
      && call.content[0].type === 'text'
      && call.content[0].text === 'hello team'))
  check('only the unselected session was skipped', loaded.deliveries.every((call) => call.id !== 's-d'))
  check('summary reports two delivered and one failed', host.textContent.includes('成功 2 个，失败 1 个'), host.querySelector('.sbc-results').textContent)
  check('failure reason is shown', host.textContent.includes('session/agent-busy'), host.querySelector('.sbc-results').textContent)
  check('success marks rendered', host.querySelectorAll('.sbc-result__mark.is-ok').length === 2)
  check('only the failed row stays selected', host.querySelectorAll('.sbc-row.is-checked').length === 1)

  // Retry resends only the failure, keeping the draft.
  const retry = [...host.querySelectorAll('.sbc-btn')].find((node) => node.textContent === '重试失败项')
  check('retry button offered', retry !== undefined)
  if (retry !== undefined) retry.click()
  await waitFor(() => loaded.deliveries.length === 4, 'retry delivery', 8_000)
  await waitFor(() => host.querySelector('.sbc-btn.is-primary').textContent === '发送', 'batch to settle', 8_000)
  check('retry targeted only the failed session', loaded.deliveries[3].id === 's-b')
  check('draft kept for the retry', loaded.deliveries[3].content[0].text === 'hello team')

  // Escape closes; the button reflects the closed state.
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => host.querySelector('.sbc-dialog') === null, 'escape closes')
  check('button no longer marked open', host.querySelector('button.sbc-tool').className === 'sbc-tool')
}

console.log('session-broadcast: box classification')
{
  const loaded = loadPlugin()
  const { host } = mount(loaded)
  await waitFor(() => host.querySelector('button.sbc-tool'), 'toolbar button')
  host.querySelector('button.sbc-tool').click()
  await waitFor(() => host.querySelectorAll('.sbc-filter').length >= 5, 'box chips')

  const chips = [...host.querySelectorAll('.sbc-filter')]
  const chipFor = (label) => chips.find((node) => node.querySelector('.sbc-filter__name')?.textContent === label)
  const rowFor = (title) => [...host.querySelectorAll('.sbc-row')].find((node) => node.textContent.includes(title))

  check('all-and-ungrouped chips lead the row', chips[0].querySelector('.sbc-filter__name').textContent === '全部'
    && chips[1].querySelector('.sbc-filter__name').textContent === '未分组')
  check('parent box chip carries its session count', chipFor('插件制作')?.querySelector('.sbc-filter__count')?.textContent === '2')
  check('sub-box chip reads as parent then child', chipFor('插件制作 › 群发') !== undefined)
  check('ungrouped count excludes boxed sessions', chipFor('未分组')?.querySelector('.sbc-filter__count')?.textContent === '1')
  check('row badge names its box', rowFor('Court book').textContent.includes('插件制作'))
  check('sub-box badge names the full path', rowFor('Card deck').textContent.includes('插件制作 › 群发'))

  chipFor('插件制作').click()
  await waitFor(() => host.querySelectorAll('.sbc-row').length === 2, 'parent filter covers its sub-box')
  check('parent filter admits the sub-box member', host.textContent.includes('Card deck'))
  check('parent filter drops sessions from other boxes', !host.textContent.includes('Russian grammar'))
  check('active chip is pressed', chipFor('插件制作').getAttribute('aria-pressed') === 'true')

  host.querySelectorAll('.sbc-mini')[0].click()
  await waitFor(() => host.querySelectorAll('.sbc-row.is-checked').length === 2, 'select the whole box')
  type(host.querySelector('textarea.sbc-text'), 'box message')
  await waitFor(() => host.querySelector('.sbc-btn.is-primary').disabled === false, 'send enabled')
  host.querySelector('.sbc-btn.is-primary').click()
  await waitFor(() => host.querySelector('.sbc-results') !== null, 'results', 8_000)
  check('delivery went only to the filtered box',
    loaded.deliveries.length === 2 && loaded.deliveries.every((call) => call.id === 's-b' || call.id === 's-c'),
    loaded.deliveries.map((call) => call.id).join(','))
}

console.log('session-broadcast: delivery mode')
{
  const loaded = loadPlugin()
  const { host } = mount(loaded)
  await waitFor(() => host.querySelector('button.sbc-tool'), 'toolbar button')
  host.querySelector('button.sbc-tool').click()
  await waitFor(() => host.querySelector('.sbc-dialog') !== null, 'dialog')

  const modeBox = host.querySelector('.sbc-mode__box')
  check('queue is the default delivery mode', modeBox.checked === false)
  check('default hint explains queueing', host.querySelector('.sbc-mode__hint').textContent.includes('排队'))
  modeBox.click()
  await waitFor(() => host.querySelector('.sbc-mode__hint').textContent.includes('打断'), 'steer hint')
  check('toggle marks the interrupt state', host.querySelector('.sbc-mode').className.includes('is-steer'))

  host.querySelectorAll('.sbc-row .sbc-check')[0].click()
  type(host.querySelector('textarea.sbc-text'), 'steer message')
  await waitFor(() => host.querySelector('.sbc-btn.is-primary').disabled === false, 'send enabled')
  host.querySelector('.sbc-btn.is-primary').click()
  await waitFor(() => loaded.deliveries.length === 1, 'delivery')
  check('steer mode reaches the prompt', loaded.deliveries[0].mode === 'steer', loaded.deliveries[0].mode)
  check('steer keeps the single text part', loaded.deliveries[0].content[0].text === 'steer message')
}

console.log('session-broadcast: boxes unavailable')
{
  const loaded = loadPlugin({ boxes: 'fail' })
  const { host } = mount(loaded)
  await waitFor(() => host.querySelector('button.sbc-tool'), 'toolbar button')
  host.querySelector('button.sbc-tool').click()
  await waitFor(() => host.querySelector('.sbc-dialog') !== null, 'dialog')
  await new Promise((resolve) => setTimeout(resolve, 150))
  check('box chips stay hidden without the box plugin', host.querySelectorAll('.sbc-filter').length === 0)
  check('the picker still lists every session', host.querySelectorAll('.sbc-row').length === 4)
  check('rows fall back to the session id', host.querySelector('.sbc-meta') !== null)
}

console.log(failures === 0 ? '\nsession-broadcast: all checks passed' : '\nsession-broadcast: ' + failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
