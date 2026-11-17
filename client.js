/**
 * dsh-session-broadcast — browser half.
 *
 * One composer toolbar button and one overlay dialog: pick any number of
 * Sessions, type one message, send it to all of them.
 *
 * How it delivers
 * ---------------
 * Every target receives the message through the same path the composer uses,
 * `Session.prompt(content, 'queue')`, so a broadcast is indistinguishable from
 * typing the text into each Session by hand:
 *  - the message is a durable user message with a `queue` delivery mode, so a
 *    Session that is mid-turn receives it after its current turn instead of
 *    being interrupted;
 *  - a cold Session resumes on the Host exactly as a typed prompt would;
 *  - the retention is held only for the duration of the call
 *    (`sessions.using(id, { source }, ...)`), so the picker never keeps a
 *    Session open after it sends.
 *
 * The catalog is `sessions.list`, the live projection the sidebar reads, so
 * titles, running state, and workspace membership always match what the user
 * sees. Nothing is persisted: the dialog holds a draft for the page session
 * only.
 *
 * Rendering rules: visible copy comes from the Client locale service, colors
 * from theme tokens, and cleanup returns through `ctx.effect`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-broadcast',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } = React

    /** Locale namespace shared by the two components. */
    const NS = 'session-broadcast'
    /** Reference-source name recorded on retained Sessions. */
    const SOURCE = 'broadcast'
    /** Delivery mode: append after the current turn, never interrupt it. */
    const MODE = 'queue'
    /** Delivery mode that interrupts the running turn immediately. */
    const MODE_STEER = 'steer'
    /** Same-origin route owned by dsh-session-boxes; GET returns `{ ok, state }`. */
    const BOX_ENDPOINT = '/session-boxes'
    /** Filter value meaning "sessions with no box". */
    const UNGROUPED = '__ungrouped__'
    /** Palette dsh-session-boxes accepts; anything else renders as blue. */
    const BOX_COLORS = new Set(['blue', 'green', 'amber', 'red', 'purple', 'pink', 'cyan', 'gray'])
    /** Palette colours, mirrored so a box chip matches the sidebar header. */
    const BOX_HEX = {
      blue: '#4C8DFF',
      green: '#3FB950',
      amber: '#D29922',
      red: '#F85149',
      purple: '#A371F7',
      pink: '#DB61A2',
      cyan: '#39C5CF',
      gray: '#8B949E',
    }

    const ZH = {
      'button.title': '群发消息到多个会话',
      'button.label': '群发',
      'dialog.title': '群发消息',
      'dialog.hint': '勾选会话后发送，每个会话收到同一条消息。',
      'dialog.close': '关闭',
      'dialog.placeholder': '要发送给所有已选会话的消息…',
      'dialog.search': '筛选会话标题或工作区',
      'dialog.selectAll': '全选',
      'dialog.clearAll': '清空',
      'dialog.send': '发送',
      'dialog.sending': '发送中…',
      'dialog.cancel': '取消',
      'dialog.retry': '重试失败项',
      'dialog.done': '完成',
      'count.selected': '已选 {n} 个会话',
      'count.all': '共 {m} 个会话',
      'notice.emptyText': '请先输入要发送的消息。',
      'notice.emptyTargets': '请至少勾选一个会话。',
      'notice.sending': '正在发送，请稍候…',
      'results.title': '发送结果',
      'results.summary': '成功 {ok} 个，失败 {fail} 个',
      'results.ok': '已排队',
      'empty': '没有可发送的会话。',
      'row.running': '运行中',
      'row.subagent': '子代理',
      'row.blank': '新会话',
      'row.id': '会话 {id}',
      'subtitle.running': '运行中',
      'boxes.label': '按箱子筛选',
      'boxes.all': '全部',
      'boxes.ungrouped': '未分组',
      'mode.toggle': '打断当前回合',
      'mode.queueHint': '排队：等目标会话当前回合结束后再发送，不打断。',
      'mode.steerHint': '打断：立即中断目标会话的当前回合，马上处理这条消息。',
    }

    const EN = {
      'button.title': 'Send one message to several sessions',
      'button.label': 'Broadcast',
      'dialog.title': 'Broadcast a message',
      'dialog.hint': 'Pick the sessions, then send; every session receives the same message.',
      'dialog.close': 'Close',
      'dialog.placeholder': 'Message to send to every selected session…',
      'dialog.search': 'Filter by session title or workspace',
      'dialog.selectAll': 'Select all',
      'dialog.clearAll': 'Clear',
      'dialog.send': 'Send',
      'dialog.sending': 'Sending…',
      'dialog.cancel': 'Cancel',
      'dialog.retry': 'Retry failed',
      'dialog.done': 'Done',
      'count.selected': '{n} selected',
      'count.all': '{m} sessions',
      'notice.emptyText': 'Type the message to send first.',
      'notice.emptyTargets': 'Select at least one session.',
      'notice.sending': 'Sending, please wait…',
      'results.title': 'Delivery results',
      'results.summary': '{ok} delivered, {fail} failed',
      'results.ok': 'Queued',
      'empty': 'No session to send to.',
      'row.running': 'Running',
      'row.subagent': 'Subagent',
      'row.blank': 'New session',
      'row.id': 'Session {id}',
      'subtitle.running': 'Running',
      'boxes.label': 'Filter by box',
      'boxes.all': 'All',
      'boxes.ungrouped': 'Ungrouped',
      'mode.toggle': 'Interrupt the current turn',
      'mode.queueHint': 'Queued: sent after each target finishes its current turn, without interrupting.',
      'mode.steerHint': 'Steer: interrupts each target’s current turn and handles this message immediately.',
    }

    /* ------------------------------------------------------------------ *
     * Pure derivation
     * ------------------------------------------------------------------ */

    /** Trailing path segment of a Windows or POSIX directory. */
    function basename(path) {
      if (typeof path !== 'string') return ''
      const trimmed = path.replace(/[\\/]+$/, '')
      if (trimmed === '') return ''
      const parts = trimmed.split(/[\\/]/)
      return parts[parts.length - 1] ?? ''
    }

    /** The durable title, then the display title, then the raw id. */
    function titleOf(row, fallback) {
      const title = typeof row?.title === 'string' ? row.title.trim() : ''
      if (title !== '') return title
      const display = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
      if (display !== '') return display
      return fallback
    }

    /**
     * Project the Session catalog onto picker rows.
     *
     * Every listed Session is offered, including subagents and unused blank
     * Sessions: the user decides what to target. Running Sessions sort first so
     * a broadcast meant to unblock work is easy to aim, then by last activity.
     *
     * @param catalog - `sessions.list` snapshot (`ids` plus `byId`).
     * @param labels - workspace title lookup for one Session id.
     * @returns rows sorted for display.
     */
    function buildRows(catalog, labels) {
      const rows = []
      const ids = Array.isArray(catalog?.ids) ? catalog.ids : []
      const byId = catalog?.byId ?? {}
      for (const id of ids) {
        const row = byId[id]
        if (row === null || row === undefined) continue
        const cwd = typeof row.cwd === 'string' ? row.cwd : ''
        rows.push({
          id,
          title: titleOf(row, id),
          workspace: labels.get(id) ?? basename(cwd),
          running: row.running === true,
          blank: row.blank === true,
          subagent: row.origin === 'subagent',
          updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        })
      }
      rows.sort((left, right) =>
        Number(right.running) - Number(left.running)
        || right.updatedAt - left.updatedAt
        || left.title.localeCompare(right.title))
      return rows
    }

    /** Whether one row matches a lowercased filter query. */
    function matchesQuery(row, query) {
      if (query === '') return true
      return row.title.toLowerCase().includes(query)
        || row.workspace.toLowerCase().includes(query)
        || row.id.toLowerCase().includes(query)
    }

    /** Count the rows the user actually selected. */
    function selectedCount(rows, selected) {
      let count = 0
      for (const row of rows) if (selected[row.id] === true) count += 1
      return count
    }

    /** Workspace titles by Session id, built in one pass. */
    function workspaceTitles(ctx) {
      const labels = new Map()
      const items = ctx.get('workspaces')?.list?.getSnapshot?.()?.items
      if (!Array.isArray(items)) return labels
      for (const item of items) {
        if (!Array.isArray(item?.sessionIds)) continue
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (title === '') continue
        for (const sessionId of item.sessionIds) if (!labels.has(sessionId)) labels.set(sessionId, title)
      }
      return labels
    }

    /* ------------------------------------------------------------------ *
     * Dialog state
     * ------------------------------------------------------------------ */

    /** One small external store shared by the toolbar button and the dialog. */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          const value = typeof next === 'function' ? next(state) : next
          if (value === state) return
          state = value
          for (const listener of listeners) {
            try {
              listener()
            } catch (error) {
              console.warn('[session-broadcast] a listener failed', error)
            }
          }
        },
      }
    }

    /** The closed dialog: no draft, no selection, no result. */
    function initialState() {
      return {
        open: false,
        text: '',
        query: '',
        selected: {},
        phase: 'idle',
        results: [],
        done: 0,
        notice: '',
        mode: MODE,
        boxes: { status: 'idle', items: [], bySession: {}, error: null },
        boxFilter: null,
      }
    }

    const dialog = createStore(initialState())

    /**
     * Open the picker on a clean slate and refresh the box classification.
     *
     * The box data is read on every open rather than cached across opens, so a
     * rename, recolour, or membership change made in the sidebar is reflected
     * the next time the dialog appears.
     */
    function openDialog() {
      dialog.set((state) => ({ ...state, open: true, phase: 'idle', results: [], notice: '', query: '', boxFilter: null }))
      void loadBoxes()
    }

    function closeDialog() {
      const state = dialog.getSnapshot()
      if (state.phase === 'sending') return
      dialog.set({ ...state, open: false })
    }

    /* ------------------------------------------------------------------ *
     * Box classification (dsh-session-boxes, same-origin data)
     * ------------------------------------------------------------------ */

    /**
     * Normalize the box payload the way dsh-session-boxes does.
     *
     * Only what the picker needs survives: name, palette colour, and one level
     * of parentage. Memberships naming an unknown box are dropped, and the tree
     * is ordered parent-first so chips read like the sidebar.
     *
     * @param raw - the route's `state` value.
     * @returns `{ status, items, bySession, error }`.
     */
    function normalizeBoxes(raw) {
      const items = []
      const seen = new Set()
      for (const entry of Array.isArray(raw?.boxes) ? raw.boxes : []) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const id = typeof entry.id === 'string' ? entry.id : ''
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        items.push({
          id,
          name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id,
          color: BOX_COLORS.has(entry.color) ? entry.color : 'blue',
          parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
          order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : items.length,
        })
      }
      items.sort((left, right) => left.order - right.order)
      const byId = new Map(items.map((box) => [box.id, box]))
      for (const box of items) {
        const parent = box.parentId === null ? undefined : byId.get(box.parentId)
        box.parentId = parent !== undefined && parent.parentId === null && parent.id !== box.id ? parent.id : null
      }
      // Parent-first tree order, matching the sidebar's nesting.
      const ordered = []
      for (const box of items) if (box.parentId === null) ordered.push(box)
      for (const parent of [...ordered]) {
        for (const box of items) if (box.parentId === parent.id) ordered.push(box)
      }
      const bySession = {}
      for (const [sessionId, ids] of Object.entries(raw?.memberships ?? {})) {
        if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(ids)) continue
        const kept = []
        for (const boxId of ids) {
          if (!byId.has(boxId) || kept.includes(boxId)) continue
          kept.push(boxId)
        }
        if (kept.length > 0) bySession[sessionId] = kept
      }
      return { status: 'ready', items: ordered, bySession, error: null }
    }

    /** In-flight box read, so reopening quickly never stacks requests. */
    let boxesRequest = null

    /**
     * Refresh the box classification from its owning plugin's route.
     *
     * A missing plugin or a failed read only hides the box controls; the picker
     * keeps working without them.
     */
    function loadBoxes() {
      if (boxesRequest !== null) return boxesRequest
      dialog.set((state) => ({
        ...state,
        boxes: {
          status: state.boxes.status === 'ready' ? 'ready' : 'loading',
          items: state.boxes.items,
          bySession: state.boxes.bySession,
          error: null,
        },
      }))
      boxesRequest = (async () => {
        try {
          if (typeof fetch !== 'function') throw new Error('fetch is unavailable')
          const response = await fetch(BOX_ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          const next = normalizeBoxes(payload.state)
          dialog.set((state) => ({
            ...state,
            boxes: next,
            boxFilter: state.boxFilter !== null && state.boxFilter !== UNGROUPED
              && !next.items.some((box) => box.id === state.boxFilter) ? null : state.boxFilter,
          }))
        } catch (error) {
          console.warn('[session-broadcast] the box classification is unavailable:', error)
          dialog.set((state) => ({
            ...state,
            boxes: {
              status: state.boxes.status === 'ready' ? 'ready' : 'error',
              items: state.boxes.items,
              bySession: state.boxes.bySession,
              error: error instanceof Error ? error.message : String(error),
            },
          }))
        } finally {
          boxesRequest = null
        }
      })()
      return boxesRequest
    }

    /** A box and its direct children: selecting a parent covers its sub-boxes. */
    function boxFamily(boxId, items) {
      const family = new Set([boxId])
      for (const box of items) if (box.parentId === boxId) family.add(box.id)
      return family
    }

    /** Whether one row survives the active box filter. */
    function matchesBoxFilter(row, filter, boxes) {
      if (filter === null) return true
      if (filter === UNGROUPED) return row.boxIds.length === 0
      const family = boxFamily(filter, boxes.items)
      return row.boxIds.some((boxId) => family.has(boxId))
    }

    /** Chip label: a sub-box reads as "parent › child". */
    function boxLabel(box, items) {
      if (box.parentId === null) return box.name
      const parent = items.find((candidate) => candidate.id === box.parentId)
      return parent === undefined ? box.name : `${parent.name} › ${box.name}`
    }

    /** How many targets are written at once; small enough to keep the Host calm. */
    const CONCURRENCY = 3

    /**
     * Write one text into one Session and describe the outcome.
     *
     * The reference is taken with `retain` but its readiness is never awaited.
     * `using()` would first open the conversation, and that read pulls a history
     * page of up to 500 messages per target — pure waste when the only thing
     * being written is one short prompt. Releasing straight after the call also
     * tears that opening down, so a broadcast no longer drags conversation
     * history over the wire at all.
     *
     * @param sessions - Client Session Controller service.
     * @param id - target Session id.
     * @param title - display title captured before sending.
     * @param text - the message body.
     * @param mode - `queue` waits for the current turn, `steer` interrupts it.
     * @returns the result row; failures are described, never thrown.
     */
    async function deliverOne(sessions, id, title, text, mode) {
      let reference
      try {
        reference = sessions.retain(id, { source: SOURCE })
        const outcome = await reference.binding.session.prompt([{ type: 'text', text }], mode)
        return outcome?.ok === true
          ? { sessionId: id, title, ok: true }
          : {
              sessionId: id,
              title,
              ok: false,
              code: outcome?.error?.code ?? 'UNKNOWN',
              error: outcome?.error?.message ?? 'the Host rejected the prompt',
            }
      } catch (error) {
        return {
          sessionId: id,
          title,
          ok: false,
          code: error?.code ?? 'UNKNOWN',
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        reference?.release()
      }
    }

    /**
     * Deliver one text to every id, a few targets at a time.
     *
     * Two things keep a 10+ target broadcast quick. The first is that no target
     * waits for its conversation history (`deliverOne` prompts without awaiting
     * `ready`). The second is a small worker pool: each prompt may make the Host
     * resume a cold Session, so three in flight hide that latency without
     * starting a burst of agents. Results are stored by target index, so the
     * list still reads in display order even when replies finish out of order.
     * Each result is captured per Session, so one rejection never stops the rest.
     *
     * @param sessions - Client Session Controller service.
     * @param ids - target Session ids in display order.
     * @param text - the message body shared by every target.
     * @param names - Session id to display title, captured before sending.
     * @param mode - `queue` or `steer`.
     * @returns one result row per target, in `ids` order.
     */
    async function deliver(sessions, ids, text, names, mode) {
      const results = new Array(ids.length)
      let cursor = 0
      let completed = 0
      const worker = async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= ids.length) return
          const id = ids[index]
          results[index] = await deliverOne(sessions, id, names[id] ?? id, text, mode)
          completed += 1
          dialog.set((state) => ({
            ...state,
            results: results.filter((row) => row !== undefined),
            done: completed,
          }))
        }
      }
      const workers = Math.max(1, Math.min(CONCURRENCY, ids.length))
      await Promise.all(Array.from({ length: workers }, () => worker()))
      return results
    }

    /* ------------------------------------------------------------------ *
     * Presentation
     * ------------------------------------------------------------------ */

    const CSS = `
.sbc-tool{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sbc-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sbc-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sbc-tool.is-open{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.sbc-backdrop{position:fixed;inset:0;z-index:86;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,#000 32%,transparent)}
.sbc-dialog{display:flex;flex-direction:column;gap:10px;width:min(600px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;padding:16px 18px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px color-mix(in srgb,#000 28%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.sbc-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sbc-title{font-size:15px;font-weight:600}
.sbc-close{width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.sbc-close:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sbc-close:disabled{opacity:.4;cursor:default}
.sbc-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.sbc-text{width:100%;min-height:88px;max-height:220px;resize:vertical;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}
.sbc-text:focus{outline:2px solid var(--dsw-alias-brand-primary-new-color,#4176e6);outline-offset:-1px}
.sbc-mode{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.sbc-mode:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}
.sbc-mode.is-steer{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.sbc-mode__box{width:14px;height:14px;margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary-new-color,#4176e6)}
.sbc-mode__text{display:flex;flex-direction:column;gap:2px;min-width:0}
.sbc-mode__title{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary)}
.sbc-mode__hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.sbc-tools{display:flex;align-items:center;gap:8px}
.sbc-search{flex:1;min-width:0;height:28px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}
.sbc-mini{height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sbc-mini:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.sbc-mini:disabled{opacity:.45;cursor:default}
.sbc-filters{display:flex;flex-wrap:wrap;gap:6px;max-height:84px;overflow:auto;padding:1px}
.sbc-filter{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.sbc-filter:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sbc-filter:disabled{opacity:.5;cursor:default}
.sbc-filter.is-on{border-color:color-mix(in srgb,var(--sbc-box,var(--dsw-alias-brand-primary)) 62%,transparent);background:color-mix(in srgb,var(--sbc-box,var(--dsw-alias-brand-primary)) 14%,transparent);color:var(--dsw-alias-label-primary)}
.sbc-filter.is-nested{padding-left:6px;font-size:11.5px}
.sbc-filter__name{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbc-filter__count{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums}
.sbc-dot{width:8px;height:8px;border-radius:50%;background:var(--sbc-box,#8B949E);flex:none}
.sbc-list{flex:1;min-height:120px;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px}
.sbc-row{display:flex;align-items:center;gap:9px;padding:7px 10px;cursor:pointer;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
.sbc-row:last-child{border-bottom:0}
.sbc-row:hover{background:var(--dsw-alias-bg-layer-2)}
.sbc-row.is-checked{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.sbc-check{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.sbc-main{display:flex;flex-direction:column;min-width:0;flex:1}
.sbc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbc-meta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow:hidden}
.sbc-ws{flex:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbc-box{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:62%;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--sbc-box,#8B949E) 15%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sbc-box,#8B949E) 38%,transparent);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}
.sbc-box__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbc-tag{flex:none;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.sbc-tag.is-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,transparent);color:var(--dsw-alias-state-success-primary)}
.sbc-empty{padding:22px;text-align:center;color:var(--dsw-alias-label-secondary)}
.sbc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sbc-count{color:var(--dsw-alias-label-secondary);font-size:12px}
.sbc-actions{display:flex;align-items:center;gap:8px}
.sbc-btn{height:30px;padding:0 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.sbc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sbc-btn:disabled{opacity:.55;cursor:default}
.sbc-btn.is-primary{border-color:transparent;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff}
.sbc-btn.is-primary:hover:not(:disabled){filter:brightness(1.08)}
.sbc-btn.is-primary:disabled{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);opacity:1}
.sbc-notice{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.sbc-results{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto}
.sbc-results__title{font-size:12px;font-weight:600}
.sbc-result{display:flex;gap:8px;font-size:12px}
.sbc-result__mark{flex:none;font-weight:600}
.sbc-result__mark.is-ok{color:var(--dsw-alias-state-success-primary)}
.sbc-result__mark.is-fail{color:var(--dsw-alias-state-error-primary)}
.sbc-result__name{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbc-result__text{min-width:0;word-break:break-word;color:var(--dsw-alias-label-secondary)}
`

    /** The speaker-with-waves glyph used by the toolbar button. */
    function toolbarIcon() {
      return h('svg', {
        width: 17,
        height: 17,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 10v4a1 1 0 0 0 1 1h2.2l3.8 3.6V5.4L7.2 9H5a1 1 0 0 0-1 1z' }),
        h('path', { d: 'M15.6 8.8a5 5 0 0 1 0 6.4' }),
        h('path', { d: 'M18.6 5.9a9 9 0 0 1 0 12.2' }),
      )
    }

    /**
     * The composer toolbar button.
     *
     * @param props - slot props with the locale translator.
     */
    function ToolbarButton({ t }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const state = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot)
      return h('button', {
        type: 'button',
        className: state.open ? 'sbc-tool is-open' : 'sbc-tool',
        title: tr('button.title'),
        'aria-label': tr('button.title'),
        'aria-haspopup': 'dialog',
        'aria-expanded': state.open ? 'true' : 'false',
        onClick: openDialog,
      }, toolbarIcon())
    }

    /**
     * The picker dialog: one message, any number of Sessions, per-target results.
     *
     * @param props - slot props with `t` and the injected Client context.
     */
    function BroadcastDialog({ t, appCtx }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const state = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot)
      const sessions = appCtx.get('sessions')
      const listSource = useMemo(() => ({
        subscribe: (listener) => sessions.list.subscribe(listener),
        getSnapshot: () => sessions.list.getSnapshot(),
      }), [sessions])
      const catalog = useSyncExternalStore(listSource.subscribe, listSource.getSnapshot)

      const boxes = state.boxes
      const rows = useMemo(() => buildRows(catalog, workspaceTitles(appCtx)).map((row) => ({
        ...row,
        boxIds: boxes.bySession[row.id] ?? [],
      })), [catalog, appCtx, boxes])
      const query = state.query.trim().toLowerCase()
      const visible = useMemo(
        () => rows.filter((row) => matchesQuery(row, query) && matchesBoxFilter(row, state.boxFilter, boxes)),
        [rows, query, state.boxFilter, boxes],
      )
      const boxCounts = useMemo(() => {
        const counts = new Map()
        for (const box of boxes.items) {
          const family = boxFamily(box.id, boxes.items)
          counts.set(box.id, rows.filter((row) => row.boxIds.some((boxId) => family.has(boxId))).length)
        }
        return { counts, ungrouped: rows.filter((row) => row.boxIds.length === 0).length }
      }, [rows, boxes])
      const showBoxes = boxes.status === 'ready' && boxes.items.length > 0
      const chosen = selectedCount(rows, state.selected)
      const textRef = useRef(null)
      const priorOpen = useRef(false)
      const sending = state.phase === 'sending'
      const done = state.phase === 'done'
      const failures = done ? state.results.filter((row) => row.ok !== true) : []
      const delivered = done ? state.results.filter((row) => row.ok === true).length : 0

      // Focus the message box when the dialog opens, and restore focus after.
      useEffect(() => {
        if (state.open === priorOpen.current) return
        priorOpen.current = state.open
        if (state.open) {
          const handle = requestAnimationFrame(() => textRef.current?.focus?.())
          return () => cancelAnimationFrame(handle)
        }
        return undefined
      }, [state.open])

      // Escape closes the dialog unless a batch is in flight.
      useEffect(() => {
        if (!state.open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (dialog.getSnapshot().phase === 'sending') return
          event.preventDefault()
          closeDialog()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [state.open])

      const setText = useCallback((text) => {
        dialog.set((current) => ({ ...current, text, notice: '' }))
      }, [])

      const setQuery = useCallback((value) => {
        dialog.set((current) => ({ ...current, query: value }))
      }, [])

      const toggle = useCallback((id, checked) => {
        dialog.set((current) => ({ ...current, selected: { ...current.selected, [id]: checked }, notice: '' }))
      }, [])

      const selectVisible = useCallback((value) => {
        dialog.set((current) => {
          const visibleIds = visible.map((row) => row.id)
          const selected = { ...current.selected }
          for (const id of visibleIds) {
            if (value) selected[id] = true
            else delete selected[id]
          }
          return { ...current, selected, notice: '' }
        })
      }, [visible])

      /** Clicking the active box chip again clears the filter. */
      const pickFilter = useCallback((value) => {
        dialog.set((current) => ({ ...current, boxFilter: current.boxFilter === value ? null : value }))
      }, [])

      const submit = useCallback(async () => {
        const current = dialog.getSnapshot()
        if (current.phase === 'sending') return
        const text = current.text.trim()
        if (text === '') {
          dialog.set({ ...current, notice: 'empty-text' })
          return
        }
        const ids = rows.filter((row) => current.selected[row.id] === true).map((row) => row.id)
        if (ids.length === 0) {
          dialog.set({ ...current, notice: 'empty-targets' })
          return
        }
        const names = {}
        for (const row of rows) names[row.id] = row.title
        dialog.set({ ...current, phase: 'sending', results: [], notice: '', done: 0 })
        const results = await deliver(sessions, ids, text, names, current.mode === MODE_STEER ? MODE_STEER : MODE)
        const selected = {}
        for (const row of results) if (row.ok !== true) selected[row.sessionId] = true
        dialog.set((latest) => ({ ...latest, phase: 'done', results, selected }))
      }, [rows, sessions])

      const onKeyDown = useCallback((event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      }, [submit])

      if (!state.open) return null

      const notice = state.notice === 'empty-text'
        ? tr('notice.emptyText')
        : state.notice === 'empty-targets' ? tr('notice.emptyTargets') : ''
      const progress = sending ? state.done : 0

      /** One box filter chip; a coloured dot carries the sidebar's colour. */
      const filterChip = (value, label, count, color, nested) => h('button', {
        key: value === null ? 'all' : value,
        type: 'button',
        className: ['sbc-filter', state.boxFilter === value ? 'is-on' : '', nested ? 'is-nested' : '']
          .filter((part) => part !== '')
          .join(' '),
        style: color === undefined ? undefined : { '--sbc-box': BOX_HEX[color] ?? BOX_HEX.blue },
        'aria-pressed': state.boxFilter === value ? 'true' : 'false',
        disabled: sending,
        onClick: () => pickFilter(value),
      },
        color === undefined ? null : h('i', { className: 'sbc-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'sbc-filter__name' }, label),
        h('span', { className: 'sbc-filter__count' }, String(count)),
      )

      /** Workspace plus one badge per box the row belongs to. */
      const rowMeta = (row) => {
        const parts = []
        if (row.workspace !== '') {
          parts.push(h('span', { key: 'workspace', className: 'sbc-ws', title: row.workspace }, row.workspace))
        }
        for (const boxId of row.boxIds) {
          const box = boxes.items.find((candidate) => candidate.id === boxId)
          if (box === undefined) continue
          const label = boxLabel(box, boxes.items)
          parts.push(h('span', {
            key: 'box:' + boxId,
            className: 'sbc-box',
            title: label,
            style: { '--sbc-box': BOX_HEX[box.color] ?? BOX_HEX.blue },
          },
            h('i', { className: 'sbc-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'sbc-box__name' }, label),
          ))
        }
        if (parts.length === 0) parts.push(h('span', { key: 'id' }, tr('row.id', { id: row.id })))
        return parts
      }

      return h('div', {
        className: 'sbc-backdrop',
        role: 'presentation',
        onClick: (event) => {
          if (event.target === event.currentTarget && !sending) closeDialog()
        },
      },
        h('div', {
          className: 'sbc-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr('dialog.title'),
        },
          h('div', { className: 'sbc-head' },
            h('span', { className: 'sbc-title' }, tr('dialog.title')),
            h('button', {
              type: 'button',
              className: 'sbc-close',
              title: tr('dialog.close'),
              'aria-label': tr('dialog.close'),
              disabled: sending,
              onClick: closeDialog,
            }, '×'),
          ),
          h('p', { className: 'sbc-hint' }, tr('dialog.hint')),
          h('textarea', {
            ref: textRef,
            className: 'sbc-text',
            value: state.text,
            placeholder: tr('dialog.placeholder'),
            disabled: sending,
            spellCheck: false,
            onKeyDown,
            onChange: (event) => setText(event.target.value),
          }),
          h('label', { className: state.mode === MODE_STEER ? 'sbc-mode is-steer' : 'sbc-mode' },
            h('input', {
              type: 'checkbox',
              className: 'sbc-mode__box',
              checked: state.mode === MODE_STEER,
              disabled: sending,
              onChange: (event) => dialog.set((current) => ({
                ...current,
                mode: event.target.checked ? MODE_STEER : MODE,
              })),
            }),
            h('span', { className: 'sbc-mode__text' },
              h('span', { className: 'sbc-mode__title' }, tr('mode.toggle')),
              h('span', { className: 'sbc-mode__hint' },
                state.mode === MODE_STEER ? tr('mode.steerHint') : tr('mode.queueHint')),
            ),
          ),
          h('div', { className: 'sbc-tools' },
            h('input', {
              className: 'sbc-search',
              type: 'search',
              value: state.query,
              placeholder: tr('dialog.search'),
              'aria-label': tr('dialog.search'),
              disabled: sending,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'sbc-mini',
              disabled: sending || visible.length === 0,
              onClick: () => selectVisible(true),
            }, tr('dialog.selectAll')),
            h('button', {
              type: 'button',
              className: 'sbc-mini',
              disabled: sending || chosen === 0,
              onClick: () => selectVisible(false),
            }, tr('dialog.clearAll')),
          ),
          showBoxes
            ? h('div', { className: 'sbc-filters', role: 'group', 'aria-label': tr('boxes.label') },
              filterChip(null, tr('boxes.all'), rows.length, undefined, false),
              filterChip(UNGROUPED, tr('boxes.ungrouped'), boxCounts.ungrouped, undefined, false),
              boxes.items.map((box) => filterChip(
                box.id,
                boxLabel(box, boxes.items),
                boxCounts.counts.get(box.id) ?? 0,
                box.color,
                box.parentId !== null,
              )),
            )
            : null,
          h('div', { className: 'sbc-list', role: 'group', 'aria-label': tr('button.label') },
            visible.length === 0
              ? h('div', { className: 'sbc-empty' }, tr('empty'))
              : visible.map((row) => h('label', {
                  key: row.id,
                  className: state.selected[row.id] === true ? 'sbc-row is-checked' : 'sbc-row',
                },
                  h('input', {
                    type: 'checkbox',
                    className: 'sbc-check',
                    checked: state.selected[row.id] === true,
                    disabled: sending,
                    onChange: (event) => toggle(row.id, event.target.checked),
                  }),
                  h('span', { className: 'sbc-main' },
                    h('span', { className: 'sbc-name', title: row.title }, row.title),
                    h('span', { className: 'sbc-meta' }, rowMeta(row)),
                  ),
                  row.subagent ? h('span', { className: 'sbc-tag' }, tr('row.subagent')) : null,
                  row.blank ? h('span', { className: 'sbc-tag' }, tr('row.blank')) : null,
                  row.running ? h('span', { className: 'sbc-tag is-running' }, tr('row.running')) : null,
                )),
          ),
          h('div', { className: 'sbc-foot' },
            h('span', { className: 'sbc-count' }, notice !== ''
              ? h('span', { className: 'sbc-notice' }, notice)
              : sending
                ? tr('dialog.sending') + ' ' + progress + '/' + chosen
                : tr('count.selected', { n: chosen }) + ' · ' + tr('count.all', { m: rows.length })),
            h('div', { className: 'sbc-actions' },
              h('button', {
                type: 'button',
                className: 'sbc-btn',
                disabled: sending,
                onClick: closeDialog,
              }, tr('dialog.cancel')),
              h('button', {
                type: 'button',
                className: 'sbc-btn is-primary',
                disabled: sending || chosen === 0 || state.text.trim() === '',
                onClick: () => { void submit() },
              }, sending ? tr('dialog.sending') : tr('dialog.send')),
            ),
          ),
          done
            ? h('div', { className: 'sbc-results' },
              h('div', { className: 'sbc-results__title' }, tr('results.title')),
              h('div', { className: 'sbc-count' }, tr('results.summary', { ok: delivered, fail: failures.length })),
              state.results.map((row) => h('div', { key: row.sessionId, className: 'sbc-result' },
                h('span', { className: row.ok === true ? 'sbc-result__mark is-ok' : 'sbc-result__mark is-fail' },
                  row.ok === true ? '✓' : '✕'),
                h('span', { className: 'sbc-result__name', title: row.title }, row.title),
                h('span', { className: 'sbc-result__text' },
                  row.ok === true ? tr('results.ok') : (row.code ? row.code + ': ' : '') + row.error),
              )),
              failures.length > 0
                ? h('div', { className: 'sbc-actions' },
                  h('button', {
                    type: 'button',
                    className: 'sbc-btn',
                    disabled: sending,
                    onClick: () => { void submit() },
                  }, tr('dialog.retry')),
                )
                : null,
            )
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        if (sessions === undefined || typeof sessions.retain !== 'function' || sessions.list === undefined) {
          throw new Error('session-broadcast: the sessions service is unavailable')
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-session-broadcast/SessionBroadcast.css')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'session-broadcast: styles')

        ctx.effect(() => ctx.locale.register(NS, {
          zh: ZH,
          en: EN,
          ja: EN,
          es: EN,
          fr: EN,
          de: EN,
          ru: EN,
          pt: EN,
        }), 'session-broadcast: dictionaries')

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'session-broadcast-button',
          order: 40,
          locale: NS,
        }, ToolbarButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-broadcast-dialog',
          order: 72,
          locale: NS,
          inject: () => ({ appCtx: ctx }),
        }, BroadcastDialog))
      },
    }
  },
})
