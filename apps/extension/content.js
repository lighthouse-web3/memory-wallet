// Memory Wallet by Lighthouse — content script for ChatGPT, NEAR AI Private Chat and Venice.
//
// It adds a small panel to the chat app. The panel opens your vault (the Memory Wallet web page)
// in a popup and talks to it over postMessage, exactly like any other app would. The vault holds
// the key, re-checks this site's grant on NEAR before every request, and sends back only what the
// grant allows: memory text when you granted "reveal", nothing when you revoked.
// This script never sees your key, and nothing here is sent anywhere except into the vault window
// and into the chat box when you click Insert.
;(() => {
  if (window.__memoryWalletLoaded) return
  window.__memoryWalletLoaded = true

  const DEFAULT_VAULT = 'https://lighthouse-memory-wallet.vercel.app'
  /** What every chat app asks for. Health stays out unless you add it in the vault. */
  const SCOPES = ['preferences', 'travel', 'food', 'work', 'venice']
  const SAVE_SCOPES = ['preferences', 'travel', 'food', 'work']
  const SITES = {
    'chatgpt.com': { name: 'ChatGPT', tee: false },
    'chat.openai.com': { name: 'ChatGPT', tee: false },
    'private.near.ai': { name: 'NEAR AI Private Chat', tee: true },
    'chat.near.ai': { name: 'NEAR AI Private Chat', tee: true },
    'venice.ai': { name: 'Venice', tee: false, venice: true },
  }
  const site = SITES[location.hostname] || { name: location.hostname, tee: false }
  const APP = location.origin

  const state = {
    vaultUrl: DEFAULT_VAULT,
    popup: null,
    phase: 'idle', // idle | waiting | ready | closed | revoked
    grant: null,
    hits: [],
    note: '',
    noteKind: '',
    busy: '',
    lastSelection: '',
  }
  const pending = new Map()

  // ── Vault connection ─────────────────────────────────────────────────────────────────────
  function loadVaultUrl() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ vaultUrl: DEFAULT_VAULT }, (v) => resolve((v && v.vaultUrl) || DEFAULT_VAULT))
      } catch {
        resolve(DEFAULT_VAULT)
      }
    })
  }
  const vaultOrigin = () => new URL(state.vaultUrl).origin

  function connect() {
    const q = new URLSearchParams({ app: APP, name: site.name, scopes: SCOPES.join(','), write: '1', reveal: '1' })
    state.popup = window.open(`${state.vaultUrl}/#/connect?${q}`, 'memory-wallet', 'popup,width=520,height=800')
    if (!state.popup) return note('Your browser blocked the wallet window. Allow popups for this site and try again.', 'bad')
    state.phase = 'waiting'
    note('')
    render()
    const timer = setInterval(() => {
      if (!state.popup || state.popup.closed) {
        clearInterval(timer)
        if (state.phase !== 'revoked') state.phase = 'closed'
        state.popup = null
        for (const p of pending.values()) p.reject(new Error('The wallet window closed.'))
        pending.clear()
        render()
      }
    }, 800)
  }

  window.addEventListener('message', (event) => {
    if (!state.popup || event.source !== state.popup || event.origin !== vaultOrigin()) return
    const data = event.data
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('mw:')) return
    if (data.type === 'mw:ready') {
      state.grant = data
      state.phase = 'ready'
      note('')
      return render()
    }
    if (data.type === 'mw:error' && data.code === 'not-granted') {
      state.phase = 'revoked'
      state.grant = null
    }
    const p = data.id && pending.get(data.id)
    if (!p) return render()
    pending.delete(data.id)
    if (data.type === 'mw:error') p.reject(new Error(data.message || 'The wallet refused.'))
    else p.resolve(data)
  })

  function ask(message, timeoutMs = 90_000) {
    if (!state.popup || state.popup.closed) return Promise.reject(new Error('Connect your Memory Wallet first.'))
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id)
        reject(new Error('The wallet did not answer in time.'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      })
      state.popup.postMessage({ ...message, id }, vaultOrigin())
    })
  }

  // ── The chat box ────────────────────────────────────────────────────────────────────────
  const visible = (el) => {
    if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) return false
    const r = el.getBoundingClientRect()
    return r.width > 120 && r.height > 16 && getComputedStyle(el).visibility !== 'hidden'
  }
  const editable = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable)

  function findComposer() {
    const chatgpt = document.querySelector('#prompt-textarea')
    if (chatgpt && visible(chatgpt)) return chatgpt
    const active = document.activeElement
    if (editable(active) && !host.contains(active)) return active
    const all = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(
      (el) => visible(el) && !host.contains(el),
    )
    // Chat boxes sit at the bottom of the page.
    return all.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null
  }

  const composerText = (el) => (el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '') : '').trim()

  function insert(el, text) {
    el.focus()
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, el.value.trim() ? `${el.value}\n\n${text}` : text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const payload = el.innerText.trim() ? `\n\n${text}` : text
    // Rich editors (ProseMirror, Lexical) handle a paste with line breaks best.
    const data = new DataTransfer()
    data.setData('text/plain', payload)
    const pasted = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return pasted || document.execCommand('insertText', false, payload)
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    if (text && !(sel.anchorNode && host.contains(sel.anchorNode))) state.lastSelection = text.slice(0, 2000)
  })

  // ── Actions ─────────────────────────────────────────────────────────────────────────────
  async function findMemories() {
    const query = composerText(findComposer()) || 'what should you know about me'
    await run('find', async () => {
      // The vault shows the matches in its own window; only what you tick there comes back here.
      if (state.popup) state.popup.focus()
      note('Pick what to share in your Memory Wallet window…')
      const res = await ask({ type: 'mw:recall', query, limit: 6 }, 300_000)
      state.hits = res.memories.map((m) => ({ ...m, picked: true }))
      note(
        res.memories.length
          ? `You shared ${res.memories.length} (recalled with Lighthouse Memory, ${res.how === 'semantic' ? 'meaning + keywords' : 'keywords'}).`
          : 'Nothing shared.',
      )
    })
  }

  function insertPicked() {
    const picked = state.hits.filter((h) => h.picked)
    const el = findComposer()
    if (!el) return note('Could not find the chat box on this page. Click into it, then try again.', 'bad')
    const block = ['Context from my Memory Wallet (shared by me):', ...picked.map((h) => `- ${h.text}`)].join('\n')
    insert(el, block)
    note(`Inserted ${picked.length} ${picked.length === 1 ? 'memory' : 'memories'}. ${site.tee ? '' : `${site.name} will see them when you send.`}`)
    panel.hidden = true
    el.focus()
  }

  async function saveSelection(scope) {
    const text = state.lastSelection
    if (!text) return note('Select some text in the chat first, then save it.', 'bad')
    await run('save', async () => {
      await ask({ type: 'mw:remember', scope, text })
      note(`Saved to ${scope}, encrypted in your wallet.`)
      state.lastSelection = ''
    })
  }

  async function importVenice() {
    await run('venice', async () => {
      const found = await readVeniceMemories()
      const c = found.counts
      const seen = `${c.memories} memory ${c.memories === 1 ? 'chunk' : 'chunks'}, ${c.profile} profile and ${c.relationship} relationship ${c.profile + c.relationship === 1 ? 'record' : 'records'}`
      if (!found.texts.length) {
        return note(
          c.memories + c.profile + c.relationship
            ? `Found ${seen} in Venice's storage here, but no readable text (Venice may encrypt them in this browser).`
            : "Venice hasn't stored any memory in this browser yet (checked its memories, profile insights and relationship insights). Chat a little with Memory on, then try again.",
          'bad',
        )
      }
      let added = 0
      let skipped = 0
      for (let i = 0; i < found.texts.length; i += 500) {
        const res = await ask({ type: 'mw:import', scope: 'venice', texts: found.texts.slice(i, i + 500), label: 'Venice' }, 180_000)
        added += res.added
        skipped += res.skipped
      }
      note(`Read ${seen} from Venice. Stored ${added} memories in your wallet, encrypted${skipped ? `; ${skipped} were already there` : ''}.`)
    })
  }

  /**
   * Venice keeps its memory in RxDB collections in this browser's IndexedDB:
   *  - entityInsights (entityType "user"): what Venice has learned about you — name, revealed facts,
   *    preferences, profession, opinions, communication style…
   *  - relationshipInsights: shared history, topics and tasks between you and Venice;
   *  - memories: chunks Venice remembers from conversations and documents.
   * Each readable fact becomes one memory line.
   */
  async function readVeniceMemories() {
    const dbs = indexedDB.databases ? await indexedDB.databases() : []
    const texts = []
    const counts = { memories: 0, profile: 0, relationship: 0 }
    const push = (line) => {
      const t = typeof line === 'string' ? line.replace(/\s+/g, ' ').trim() : ''
      if (t.length > 2 && !looksEncrypted(t)) texts.push(t.slice(0, 2000))
    }
    for (const { name } of dbs) {
      if (!name) continue
      let db
      try {
        db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(name)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      } catch {
        continue
      }
      try {
        for (const store of [...db.objectStoreNames]) {
          const kind = (/^(memories|entityInsights|relationshipInsights)-\d+-documents$/.exec(store) || [])[1]
          if (!kind) continue
          const rows = await new Promise((resolve) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll()
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
          })
          for (const row of rows) {
            const doc = row && (row.d || row)
            if (!doc || doc._deleted) continue
            if (kind === 'memories') {
              counts.memories++
              push(doc.text)
            } else if (kind === 'entityInsights') {
              if (doc.entityType && doc.entityType !== 'user') continue
              counts.profile++
              profileLines(doc).forEach(push)
            } else {
              counts.relationship++
              relationshipLines(doc).forEach(push)
            }
          }
        }
      } finally {
        db.close()
      }
    }
    return { texts: [...new Set(texts)], counts }
  }

  const humanize = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()
  const SKIP_KEY = /^(_.*|id|ownerId|owner_id|characterId|entityType|entity[12]Id|createdAt.*|updatedAt.*|lastInteraction.*|.*UnixTimestamp|sessionCount|embedding)$/
  const textOf = (v) =>
    typeof v === 'string' ? v : v && typeof v === 'object' ? v.fact || v.text || v.content || v.statement || v.value || v.description || v.topic || v.task || v.name || '' : ''

  /** Turns a nested value into "Label: value" lines (depth-limited). */
  function flatten(value, label, depth = 0, out = []) {
    if (value === null || value === undefined || value === '' || out.length > 120) return out
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${label}: ${value}`)
    } else if (Array.isArray(value)) {
      const simple = value.map(textOf).filter((t) => typeof t === 'string' && t.trim())
      if (simple.length === value.length && simple.length) out.push(`${label}: ${simple.join(', ')}`)
      else if (depth < 3) value.forEach((v) => flatten(v, label, depth + 1, out))
    } else if (typeof value === 'object' && depth < 3) {
      for (const [k, v] of Object.entries(value)) if (!SKIP_KEY.test(k)) flatten(v, `${label}, ${humanize(k)}`, depth + 1, out)
    }
    return out
  }

  function profileLines(doc) {
    const lines = []
    if (doc.name) lines.push(`Name: ${doc.name}`)
    if (doc.nickname) lines.push(`Goes by ${doc.nickname}`)
    for (const f of Array.isArray(doc.revealedFacts) ? doc.revealedFacts : []) {
      const t = textOf(f)
      if (t) lines.push(t)
      else flatten(f, 'Fact', 0, lines)
    }
    const labels = {
      profession: 'Work', preferences: 'Preference', opinions: 'Opinion', communicationStyle: 'Communication style',
      boundaries: 'Boundaries', demographics: 'About me', education: 'Education', personalityTraits: 'Personality',
      personalityProfile: 'Personality', physicalAppearance: 'Appearance', originStory: 'Background', selfConcept: 'Self-image', tagline: 'Tagline',
    }
    for (const [key, label] of Object.entries(labels)) flatten(doc[key], label, 0, lines)
    return lines
  }

  function relationshipLines(doc) {
    const lines = []
    if (doc.sharedHistorySummary) lines.push(`History with Venice: ${doc.sharedHistorySummary}`)
    const list = (v) => (Array.isArray(v) ? v.map(textOf).filter(Boolean) : [])
    if (list(doc.sharedTopics).length) lines.push(`Talks with Venice about: ${list(doc.sharedTopics).join(', ')}`)
    if (list(doc.commonTasks).length) lines.push(`Often asks Venice to: ${list(doc.commonTasks).join(', ')}`)
    list(doc.insideReferences).forEach((r) => lines.push(`Inside reference with Venice: ${r}`))
    if (doc.perceivedRole && doc.perceivedRole !== 'unknown') lines.push(`Sees Venice as ${/^[aeiou]/.test(doc.perceivedRole) ? 'an' : 'a'} ${doc.perceivedRole}`)
    return lines
  }

  const looksEncrypted = (t) => /^U2FsdGVkX1/.test(t) || (t.length > 40 && !/\s/.test(t) && /^[A-Za-z0-9+/=_-]+$/.test(t))

  async function run(label, fn) {
    state.busy = label
    render()
    try {
      await fn()
    } catch (err) {
      note(err && err.message ? err.message : String(err), 'bad')
    } finally {
      state.busy = ''
      render()
    }
  }

  function note(text, kind = '') {
    state.note = text
    state.noteKind = kind
    render()
  }

  // ── UI (in a shadow root, so the page's CSS can't touch it) ─────────────────────────────
  const host = document.createElement('div')
  host.id = 'lighthouse-memory-wallet'
  // Open mode: the page could read shared text from postMessage anyway, so closing it would protect nothing.
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${CSS()}</style><button class="launcher" part="launcher"><span class="dot"></span>Memory</button><section class="panel" hidden></section>`
  const launcher = root.querySelector('.launcher')
  const panel = root.querySelector('.panel')
  launcher.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    render()
  })
  // Behave like a popover: a click anywhere on the page closes the panel (and still reaches what
  // was clicked, e.g. the chat box), so the panel never sits between you and the chat.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!panel.hidden && !e.composedPath().includes(host)) {
        panel.hidden = true
      }
    },
    true,
  )

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const until = (ms) => {
    const m = Math.round((ms - Date.now()) / 60000)
    return m < 60 ? `${Math.max(m, 0)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`
  }

  function render() {
    if (panel.hidden) return
    const g = state.grant
    const privacy = site.tee
      ? `${site.name} runs its models inside TEEs.`
      : `${site.name} runs outside a TEE: anything you insert, it can read.`
    let body = ''
    if (state.phase === 'ready' && g) {
      body = `
        <p class="status ok">Connected as <b>${esc(g.accountId)}</b></p>
        <p class="meta">${esc(g.scopes.join(', '))} · ${g.reveal ? 'sees memory text' : 'answers only'} · ${g.write ? 'can save' : 'read only'} · expires in ${until(g.expiresAt)} · grant on ${esc(g.registry)}</p>
        <div class="row"><button data-act="find" ${state.busy ? 'disabled' : ''}>${state.busy === 'find' ? 'Waiting for your pick…' : 'Find memories for this message'}</button></div>
        ${
          state.hits.length
            ? `<ul class="hits">${state.hits
                .map(
                  (h, i) =>
                    `<li><label><input type="checkbox" data-hit="${i}" ${h.picked ? 'checked' : ''}><span>${esc(h.text)}<small>${esc(h.scope)} · ${h.score.toFixed(2)}</small></span></label></li>`,
                )
                .join('')}</ul>
               <div class="row"><button data-act="insert" ${state.hits.some((h) => h.picked) ? '' : 'disabled'}>Insert ${state.hits.filter((h) => h.picked).length} into the message</button></div>`
            : ''
        }
        <div class="row save"><span>Save selected text to</span><select>${SAVE_SCOPES.map((s) => `<option>${s}</option>`).join('')}</select><button class="ghost" data-act="save" ${state.busy ? 'disabled' : ''}>${state.busy === 'save' ? 'Saving…' : 'Save'}</button></div>
        ${site.venice ? `<div class="row"><button class="ghost" data-act="venice" ${state.busy ? 'disabled' : ''}>${state.busy === 'venice' ? 'Importing…' : 'Store Venice memories in my wallet'}</button></div>` : ''}`
    } else {
      const text = {
        idle: `Bring your memory into ${esc(site.name)}. It stays encrypted in your wallet until you grant this site access on NEAR.`,
        waiting: 'Unlock your wallet and approve the request in the Memory Wallet window…',
        closed: 'The wallet window closed. Connect again to continue.',
        revoked: 'Access was revoked in your wallet. Requests from this site are refused.',
      }[state.phase]
      body = `<p class="status">${text}</p><div class="row"><button data-act="connect" ${state.phase === 'waiting' ? 'disabled' : ''}>${state.phase === 'waiting' ? 'Waiting for the wallet…' : 'Connect Memory Wallet'}</button></div>`
    }
    panel.innerHTML = `
      <header><span class="dot"></span><b>Memory Wallet</b><span class="by">by Lighthouse</span><button class="x" data-act="close" aria-label="Close">×</button></header>
      ${body}
      ${state.note ? `<p class="note ${state.noteKind}">${esc(state.note)}</p>` : ''}
      <p class="privacy">${esc(privacy)}</p>
      <footer>Vault: ${esc(state.vaultUrl.replace(/^https?:\/\//, ''))}</footer>`
  }

  panel.addEventListener('click', (e) => {
    const act = e.target.closest && e.target.closest('[data-act]')
    if (!act) return
    const what = act.getAttribute('data-act')
    if (what === 'close') return ((panel.hidden = true), render())
    if (what === 'connect') return connect()
    if (what === 'find') return findMemories()
    if (what === 'insert') return insertPicked()
    if (what === 'save') return saveSelection(panel.querySelector('select').value)
    if (what === 'venice') return importVenice()
  })
  panel.addEventListener('change', (e) => {
    const i = e.target.getAttribute && e.target.getAttribute('data-hit')
    if (i === null || i === undefined) return
    state.hits[Number(i)].picked = e.target.checked
    render()
  })
  // Keep the page's text selection (for Save) when clicking our buttons.
  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('button')) e.preventDefault()
  })

  function CSS() {
    return `
      :host { all: initial; font-family: 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
      * { box-sizing: border-box; font-family: inherit; }
      .launcher { font: inherit; position: fixed; right: 18px; top: 76px; z-index: 2147483646; display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 14px; border-radius: 12px; border: 1px solid #cebbe24d; color: #f4f2f7; font-size: 13px; font-weight: 600;
        background: linear-gradient(135deg, #2a2338f2, #17161cf2); box-shadow: 0 10px 40px #0006; cursor: pointer; }
      .launcher:hover { border-color: #d4baff90; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #d5b5ff; box-shadow: 0 0 14px #c794ff; flex-shrink: 0; }
      .panel { position: fixed; right: 18px; top: 124px; z-index: 2147483647; width: 340px; max-height: min(560px, calc(100vh - 150px)); overflow: auto;
        padding: 16px; border-radius: 18px; color: #f4f2f7; font-size: 13px; line-height: 1.5;
        background: linear-gradient(135deg, #ffffff0a, #ffffff02 45%), #141219f2; border: 1px solid #d0b7fb33;
        box-shadow: inset 0 1px #ffffff0d, 0 24px 70px #000a; backdrop-filter: blur(24px); }
      .panel[hidden] { display: none; }
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 14px; }
      .by { color: #a6a1b2; font-size: 12px; }
      .x { margin-left: auto; background: none; border: 0; color: #a6a1b2; font-size: 18px; cursor: pointer; padding: 0 4px; box-shadow: none; }
      p { margin: 8px 0; }
      .status b { color: #e2cdff; font-weight: 600; }
      .status.ok::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #8fe3c0; margin-right: 7px; }
      .meta, .privacy, footer { color: #a6a1b2; font-size: 12px; }
      .privacy { border-top: 1px solid #ddccff21; padding-top: 10px; margin-top: 12px; }
      footer { margin-top: 4px; }
      .row { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
      .row.save span { color: #a6a1b2; font-size: 12px; }
      button { font: inherit; font-size: 13px; font-weight: 600; padding: 9px 14px; border-radius: 9px; border: 0; cursor: pointer;
        color: #21182f; background: linear-gradient(110deg, #d4b8fd, #bdc1ff); box-shadow: inset 0 1px #f2dfff99; }
      button.ghost { color: #f4f2f7; border: 1px solid #cebbe22b; background: linear-gradient(135deg, #d2b8fb22, #b69edd09); box-shadow: none; }
      button:disabled { opacity: .5; cursor: default; }
      select { font: inherit; font-size: 12px; color: #f4f2f7; background: #0d0c10; border: 1px solid #ddccff30; border-radius: 8px; padding: 6px 8px; }
      .hits { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 6px; }
      .hits label { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; background: #ffffff06; border: 1px solid #ddccff1a; cursor: pointer; }
      .hits input { accent-color: #ceb4fb; margin-top: 3px; }
      .hits small { display: block; color: #a6a1b2; font-size: 11px; }
      .note { color: #8fe3c0; }
      .note.bad { color: #ff9494; }
    `
  }

  document.documentElement.appendChild(host)
  loadVaultUrl().then((url) => {
    state.vaultUrl = url.replace(/\/+$/, '')
    render()
  })
})()
