(() => {
  const $ = (id) => document.getElementById(id)
  const T = (key, vars) => (window.t ? window.t(key, vars) : key)
  const clientVersion = () => document.querySelector('meta[name="sd-client"]')?.content || '?'
  const KEYMAP = {
    esc: '\x1b', tab: '\t',
    up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
    home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
    pipe: '|', tilde: '~', slash: '/', dash: '-',
    ctrlc: '\x03', ctrld: '\x04',
  }

  const state = {
    session: localStorage.getItem('sd.session') || 'main',
    fontSize: Number(localStorage.getItem('sd.fontSize')) || 14,
    ws: null,
    retries: 0,
    retryTimer: null,
    alive: false,
    wakeLock: null,
    view: 'console',
    target: { kind: 'local', vmid: null, label: null },
    proxmox: false,
    pveHost: null,
    user: null,
    exited: false,
    output: '',
    sshConfigured: false,
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: state.fontSize,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: 1.15,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#0b0f14',
      foreground: '#d7e2ee',
      cursor: '#38bdf8',
      selectionBackground: 'rgba(56,189,248,.3)',
      black: '#0b0f14', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#38bdf8', white: '#d7e2ee',
      brightBlack: '#4b5b6d', brightRed: '#fca5a5', brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#7dd3fc', brightWhite: '#f1f5f9',
    },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open($('term'))

  let toastTimer
  function toast(message, ms = 2400) {
    const el = $('toast')
    el.textContent = message
    el.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
  }

  function setStatus(text, mode) {
    $('status').textContent = text
    const dot = $('dot')
    dot.classList.toggle('on', mode === 'on')
    dot.classList.toggle('warn', mode === 'warn')
  }

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options })
    if (res.status === 401) {
      location.href = '/login'
      throw new Error('non authentifié')
    }
    return res
  }

  const fmtBytes = (bytes) => {
    if (!bytes && bytes !== 0) return '—'
    const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po']
    let i = 0
    let value = bytes
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
  }

  const fmtUptime = (seconds) => {
    if (!seconds) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return `${d} j ${h} h`
    if (h > 0) return `${h} h ${m} min`
    return `${m} min`
  }

  const fmtAgo = (ms) => {
    const diff = Math.max(0, Date.now() - ms)
    if (diff < 60000) return "à l'instant"
    if (diff < 3600000) return `il y a ${Math.round(diff / 60000)} min`
    if (diff < 86400000) return `il y a ${Math.round(diff / 3600000)} h`
    return `il y a ${Math.round(diff / 86400000)} j`
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ cols: String(term.cols || 80), rows: String(term.rows || 24) })
    if (state.target.kind === 'ct') {
      params.set('kind', 'ct')
      params.set('vmid', String(state.target.vmid))
    } else if (state.target.kind === 'host') {
      params.set('kind', 'host')
    } else {
      params.set('session', state.session)
    }
    return `${proto}//${location.host}/ws?${params}`
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  // Texte tapé/collé pendant une coupure : envoyé dès la reconnexion.
  function sendOrQueue(text) {
    if (send({ t: 'i', d: text })) return 'sent'
    state.pending = ((state.pending || '') + text).slice(-20000)
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connect()
    return 'queued'
  }

  function fitAndSend() {
    if (state.view !== 'console') return
    try { fit.fit() } catch {}
    send({ t: 'r', c: term.cols, r: term.rows })
  }

  function showOverlay(title, text, altLabel) {
    $('overlayTitle').textContent = title
    $('overlayText').textContent = text
    const alt = $('overlayAlt')
    alt.classList.toggle('hidden', !altLabel)
    if (altLabel) alt.textContent = altLabel
    $('overlay').classList.remove('hidden')
  }

  function hideOverlay() { $('overlay').classList.add('hidden') }

  function returnLabel() {
    return state.target.kind === 'local' ? null : 'Revenir à la session locale'
  }

  function describeExit(code) {
    const tail = state.output
    if (/permission denied|too many authentication failures/i.test(tail)) {
      return 'Accès SSH refusé par le nœud. Vérifie la clé autorisée (packaging/proxmox-setup.sh) puis relance npm run setup:pve.'
    }
    if (/connection refused|connection timed out|no route to host/i.test(tail)) {
      return 'Le nœud ne répond pas en SSH. Vérifie que sshd tourne et que le port est ouvert.'
    }
    if (/commande refusée|command refused/i.test(tail)) {
      return 'La commande a été refusée par la clé restreinte : seules « host » et « ct <vmid> » sont autorisées.'
    }
    if (/ssh .*introuvable|command not found/i.test(tail)) {
      return 'SSH n\'est pas installé dans le conteneur (apt-get install -y openssh-client).'
    }
    return code === 0 || code === undefined
      ? 'La commande est sortie normalement.'
      : `La commande est sortie avec le code ${code}. Le détail est dans le terminal.`
  }

  function connect() {
    clearTimeout(state.retryTimer)
    state.exited = false
    state.output = ''
    $('overlay').classList.add('hidden')
    if (state.ws) {
      state.ws.onclose = null
      try { state.ws.close() } catch {}
    }
    try { fit.fit() } catch {}
    const ws = new WebSocket(wsUrl())
    state.ws = ws
    setStatus(T('status.connecting'), 'warn')

    ws.onopen = () => {
      state.retries = 0
      state.alive = true
      setStatus(T('status.connected'), 'on')
      hideOverlay()
      keepAwake()
      fitAndSend()
      if (state.pending) {
        const pending = state.pending
        state.pending = ''
        send({ t: 'i', d: pending })
        toast(`${pending.length} caractères envoyés`)
      }
      if (state.view === 'console') term.focus()
    }

    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.t === 'd') {
        state.output = (state.output + msg.d).slice(-4000)
        term.write(msg.d)
      } else if (msg.t === 'x') {
        state.exited = true
        state.alive = false
        showOverlay('Session terminée', describeExit(msg.c), returnLabel())
      } else if (msg.t === 'error') {
        state.exited = true
        if (state.view !== 'console') { toast(msg.m); return }
        const sshHint = /ssh|openssh/i.test(msg.m)
        showOverlay(
          'Console indisponible',
          sshHint
            ? `${msg.m}\n\nLe shell du nœud et des conteneurs passe par SSH : lance packaging/proxmox-setup.sh sur le nœud, puis npm run setup:pve dans le conteneur.`
            : msg.m,
          returnLabel(),
        )
      }
    }

    ws.onclose = () => {
      if (state.ws !== ws) return
      state.alive = false
      if (state.exited) {
        // Sortie normale (ou refus d'accès) : inutile de boucler.
        setStatus(T('status.ended'), 'off')
        clearTimeout(state.retryTimer)
        return
      }
      setStatus(T('status.offline'), 'off')
      const delay = Math.min(1000 * 2 ** state.retries, 15000)
      state.retries += 1
      if (state.retries === 3) {
        // Session révoquée / expirée : inutile de boucler, on renvoie au login.
        fetch('/api/me')
          .then((res) => { if (res.status === 401) location.href = '/login' })
          .catch(() => {})
      }
      if (state.retries <= 4) setStatus(T('status.retry', { s: Math.round(delay / 1000) }), 'warn')
      else showOverlay('Connexion perdue', 'Le serveur ne répond plus.')
      state.retryTimer = setTimeout(connect, delay)
    }
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen')
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null })
      }
    } catch {}
  }

  term.onData((data) => send({ t: 'i', d: data }))
  term.onResize(() => send({ t: 'r', c: term.cols, r: term.rows }))

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') { copySelection(); return false }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') { pasteClipboard(); return false }
    return true
  })

  function legacyCopy(text) {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    area.remove()
    return ok
  }

  async function writeClipboard(text) {
    // Hors HTTPS (app servie en http:// sur le LAN), navigator.clipboard est
    // indisponible : on retombe sur execCommand.
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        toast(T('toast.copied', { n: text.length }))
        return true
      } catch {}
    }
    if (legacyCopy(text)) {
      toast(T('toast.copied', { n: text.length }))
      return true
    }
    toast(T('toast.copyRefused'))
    return false
  }

  function copySelection() {
    const selection = term.getSelection()
    if (!selection) { toast(T('toast.selectFirst')); return }
    writeClipboard(selection)
  }

  async function pasteClipboard() {
    if (navigator.clipboard?.readText && window.isSecureContext) {
      try {
        const text = await navigator.clipboard.readText()
        if (text) { sendOrQueue(text); toast(T('toast.pasted')); return }
      } catch {}
    }
    // Hors HTTPS : on ouvre le champ de collage natif, seul chemin fiable.
    openTextSheet()
    toast('Presse-papier direct indisponible en HTTP : appui long dans le champ puis Coller')
  }

  function terminalText(maxLines = 400) {
    const buffer = term.buffer.active
    const lines = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    return lines.slice(-maxLines).join('\n')
  }

  function openTextSheet() {
    const pre = $('textArea')
    if (!pre) return
    pre.textContent = terminalText()
    closeSheets()
    $('textSheet').classList.remove('hidden')
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight })
  }

  $('copyAll').onclick = () => writeClipboard($('textArea').textContent || '')
  $('closeText').onclick = () => closeSheets()
  // iOS : le menu « Coller » ne s'ouvre pas sur le champ caché du terminal.
  // Un vrai champ de texte dans la feuille règle le problème.
  $('pasteSend').onclick = () => {
    const box = $('pasteBox')
    const text = box.value
    if (!text) { toast('Le champ est vide : colle ton texte dedans'); return }
    const result = sendOrQueue(text)
    box.value = ''
    closeSheets()
    toast(result === 'sent' ? T('toast.sent') : 'Terminal déconnecté : envoi à la reconnexion')
  }

  // --- gestes tactiles -----------------------------------------------------

  // Défilement : on pilote le tampon directement, indépendamment des gestes du
  // navigateur (sur mobile, xterm ne reçoit pas toujours les touch events).
  {
    const surface = $('term')
    let anchor = null
    let longPress = null

    surface.addEventListener('touchstart', (event) => {
      anchor = event.touches.length === 1 ? { y: event.touches[0].clientY } : null
      clearTimeout(longPress)
      // Appui long sans déplacement : ouvre la vue sélectionnable.
      if (anchor) {
        longPress = setTimeout(() => {
          longPress = null
          anchor = null
          openTextSheet()
        }, 550)
      }
    }, { passive: true })
    surface.addEventListener('touchmove', (event) => {
      if (longPress) { clearTimeout(longPress); longPress = null }
      if (!anchor || event.touches.length !== 1) return
      const y = event.touches[0].clientY
      const dy = y - anchor.y
      const lineHeight = Math.max(12, Math.round(state.fontSize * 1.15))
      if (Math.abs(dy) >= lineHeight) {
        const lines = Math.trunc(dy / lineHeight)
        term.scrollLines(-lines)
        anchor.y = y
      }
    }, { passive: true })
    surface.addEventListener('touchend', () => {
      anchor = null
      if (longPress) { clearTimeout(longPress); longPress = null }
    }, { passive: true })
    surface.addEventListener('touchcancel', () => {
      anchor = null
      if (longPress) { clearTimeout(longPress); longPress = null }
    }, { passive: true })
    surface.addEventListener('click', () => term.focus())
  }

  // Collage natif : le menu « Coller » du clavier écrit dans le champ caché
  // d'xterm ; on intercepte pour envoyer le texte tel quel à la session.
  {
    const textarea = term.textarea
    if (textarea) {
      textarea.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text/plain') || ''
        if (!text) return
        event.preventDefault()
        event.stopPropagation()
        send({ t: 'i', d: text })
        toast(T('toast.pasted'))
      }, true)
    }
  }

  term.parser.registerOscHandler(52, (data) => {
    const payload = data.split(';').pop()
    if (!payload || payload === '?') return true
    try {
      navigator.clipboard.writeText(atob(payload)).then(() => toast('Copié depuis le terminal')).catch(() => {})
    } catch {}
    return true
  })

  let ctrl = false
  let alt = false

  function applyModifiers(key) {
    if (key.length === 1) {
      let out = key
      if (ctrl) out = String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f)
      if (alt) out = '\x1b' + out
      return out
    }
    return alt ? '\x1b' + key : key
  }

  function resetModifiers() {
    ctrl = false
    alt = false
    document.querySelector('[data-k="ctrl"]')?.classList.remove('on')
    document.querySelector('[data-k="alt"]')?.classList.remove('on')
  }

  function press(name) {
    if (name === 'ctrl') {
      ctrl = !ctrl
      document.querySelector('[data-k="ctrl"]').classList.toggle('on', ctrl)
      return
    }
    if (name === 'alt') {
      alt = !alt
      document.querySelector('[data-k="alt"]').classList.toggle('on', alt)
      return
    }
    if (name === 'select') return openTextSheet()
    if (name === 'copy') return copySelection()
    if (name === 'paste') return pasteClipboard()
    const seq = KEYMAP[name]
    if (!seq) return
    sendOrQueue(applyModifiers(seq))
    resetModifiers()
    if (state.view === 'console') term.focus()
  }

  // pointerdown pour la réactivité tactile, click en secours (certains
  // navigateurs et outils n'émettent pas pointerdown).
  let lastKey = 0
  function handleKey(name) {
    lastKey = Date.now()
    press(name)
  }
  $('keys').addEventListener('pointerdown', (event) => {
    const btn = event.target.closest('button[data-k]')
    if (!btn) return
    event.preventDefault()
    handleKey(btn.dataset.k)
  })
  $('keys').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-k]')
    if (!btn) return
    if (Date.now() - lastKey < 500) return
    handleKey(btn.dataset.k)
  })

  function showView(name) {
    state.view = name
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.id === `view-${name}`)
    }
    for (const tab of document.querySelectorAll('#tabs button')) {
      tab.classList.toggle('active', tab.dataset.view === name)
    }
    $('keys').style.display = name === 'console' ? '' : 'none'
    closeSheets()
    if (name === 'console') setTimeout(fitAndSend, 60)
    if (name === 'nodes' || name === 'guests') window.SD?.refreshPve?.(name)
    if (name === 'files') window.SDFiles?.show?.()
    if (name === 'settings') renderSettings()
  }

  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('button[data-view]')
    if (tab) showView(tab.dataset.view)
  })

  function setTarget(target) {
    state.target = target
    const label = target.kind === 'host'
      ? `PVE · ${state.pveHost || 'nœud'}`
      : target.kind === 'ct'
        ? `LXC ${target.vmid}${target.label ? ' · ' + target.label : ''}`
        : `session ${target.session || state.session}`
    $('targetLabel').textContent = label
    $('targetHint').textContent = target.kind === 'host'
      ? 'shell du nœud'
      : target.kind === 'ct'
        ? 'conteneur'
        : state.sshConfigured ? 'tmux local' : 'tmux local · shell PVE non configuré'
  }

  function openConsole(target) {
    setTarget(target)
    showView('console')
    term.reset()
    connect()
    setTimeout(fitAndSend, 80)
  }

  $('targetBtn').onclick = () => {
    openTargetSheet()
    $('targetSheet').classList.remove('hidden')
  }

  async function openSshSetup() {
    closeSheets()
    const sheet = $('sshSheet')
    const body = $('sshBody')
    sheet.classList.remove('hidden')
    body.innerHTML = '<p class="empty">Chargement…</p>'
    const info = await api('/api/pve/setup').then((r) => r.json()).catch(() => ({}))
    const key = info.sshPublicKey ? `'${info.sshPublicKey}'` : `'<clé publique affichée à l\'étape 1>'`
    const host = state.pveHost || '<ip-du-nœud>'
    body.innerHTML = `
      <p class="hint">Le shell du nœud et des conteneurs passe par une clé SSH
      restreinte à deux commandes : <code>host</code> et <code>ct &lt;vmid&gt;</code>.
      Une seule commande suffit à la mettre en place — aucun identifiant à recopier.</p>
      <p class="hint"><b>Sur le nœud Proxmox, en root :</b></p>
      <code style="display:block;word-break:break-all;background:#f4f4f4;border:1px solid #e0e0e0;padding:8px;border-radius:3px;margin:6px 0">
        bash -c "$(curl -fsSL https://raw.githubusercontent.com/heyhey2thereal/ServerDeck---Better-mobile-proxmox/main/packaging/enable-ssh.sh)"
      </code>
      <p class="hint">Le script détecte le conteneur (nommé <code>serverdeck</code>), génère
      la clé, l'autorise sur le nœud et redémarre le service. Recharge ensuite cette page.</p>
      <p class="hint">En attendant, la session locale (tmux) reste disponible dans le sélecteur.</p>`
  }

  async function openTargetSheet() {
    const list = $('targetList')
    list.innerHTML = ''
    if (state.proxmox) {
      const row = document.createElement('div')
      row.className = 'sess' + (state.target.kind === 'host' ? ' active' : '')
      row.setAttribute('data-pve', '1')
      row.innerHTML = `<span class="nm">Shell du nœud PVE</span><span class="tag">${
        state.sshConfigured ? escapeHtml(state.pveHost || '') : 'SSH à configurer'
      }</span>`
      row.onclick = (event) => {
        event.stopPropagation()
        if (state.sshConfigured) { closeSheets(); openConsole({ kind: 'host' }) } else { openSshSetup() }
      }
      list.append(row)
    }
    const { sessions } = await (await api('/api/sessions')).json()
    for (const s of sessions) {
      const row = document.createElement('div')
      row.className = 'sess' + (state.target.kind === 'local' && s.name === state.session ? ' active' : '')
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = s.name
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = s.attached ? 'attachée' : ''
      const kill = document.createElement('button')
      kill.className = 'kill'
      kill.textContent = '✕'
      // Deux appuis plutôt qu'une boîte de dialogue : les confirm() natifs sont
      // peu fiables en PWA autonome sur iOS.
      kill.onclick = async (event) => {
        event.stopPropagation()
        if (kill.dataset.confirm !== '1') {
          kill.dataset.confirm = '1'
          kill.classList.add('confirm')
          kill.textContent = 'Confirmer'
          setTimeout(() => {
            if (!kill.isConnected) return
            kill.dataset.confirm = ''
            kill.classList.remove('confirm')
            kill.textContent = '✕'
          }, 3000)
          return
        }
        kill.disabled = true
        // Session active : on coupe la reconnexion, sinon le PTY la recrée.
        if (state.target.kind === 'local' && s.name === state.session) state.exited = true
        try {
          const res = await api(`/api/sessions/${encodeURIComponent(s.name)}`, { method: 'DELETE' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'refusé')
          toast(`Session « ${s.name} » supprimée`)
        } catch (err) {
          toast(err.message)
          kill.disabled = false
          return
        }
        if (state.target.kind === 'local' && s.name === state.session) {
          state.exited = true
          switchSession('main')
          return
        }
        await openTargetSheet()
      }
      row.append(nm, tag, kill)
      row.onclick = () => { closeSheets(); switchSession(s.name) }
      list.append(row)
    }
    if (!sessions.length) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = 'Aucune session tmux.'
      list.append(empty)
    }
  }

  function switchSession(name) {
    state.session = name
    localStorage.setItem('sd.session', name)
    openConsole({ kind: 'local', session: name })
  }

  $('createSession').onclick = async () => {
    const input = $('newSession')
    const name = input.value.trim()
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name)) {
      input.style.borderColor = 'var(--red)'
      return
    }
    input.style.borderColor = ''
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) })
    input.value = ''
    closeSheets()
    switchSession(name)
  }

  $('newSession').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('createSession').click()
  })

  function closeSheets() {
    for (const sheet of document.querySelectorAll('.sheet')) {
      sheet.classList.add('hidden')
      sheet.style.transform = ''
      sheet.style.transition = ''
    }
  }

  // Bouton de fermeture sur chaque feuille.
  for (const sheet of document.querySelectorAll('.sheet')) {
    if (sheet.querySelector('.sheet-close')) continue
    const btn = document.createElement('button')
    btn.className = 'sheet-close'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Fermer')
    btn.textContent = '✕'
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      closeSheets()
    })
    sheet.prepend(btn)
  }

  // Glisser vers le bas pour fermer : depuis la poignée ou depuis le contenu
  // quand il est déjà tout en haut.
  for (const sheet of document.querySelectorAll('.sheet')) {
    let startY = null
    let dy = 0
    let pulling = false
    sheet.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) { pulling = false; return }
      startY = event.touches[0].clientY
      dy = 0
      pulling = sheet.scrollTop <= 0
    }, { passive: true })
    sheet.addEventListener('touchmove', (event) => {
      if (!pulling || event.touches.length !== 1) return
      dy = event.touches[0].clientY - startY
      if (dy > 0) {
        sheet.style.transition = 'none'
        sheet.style.transform = `translateY(${dy}px)`
      }
    }, { passive: true })
    const release = () => {
      if (!pulling) return
      pulling = false
      if (dy > 110) {
        sheet.style.transition = 'transform .16s ease'
        sheet.style.transform = 'translateY(105%)'
        setTimeout(() => {
          sheet.classList.add('hidden')
          sheet.style.transform = ''
          sheet.style.transition = ''
        }, 160)
      } else {
        sheet.style.transition = 'transform .18s ease'
        sheet.style.transform = ''
        setTimeout(() => { sheet.style.transition = '' }, 200)
      }
      startY = null
      dy = 0
    }
    sheet.addEventListener('touchend', release, { passive: true })
    sheet.addEventListener('touchcancel', release, { passive: true })
  }

  // Glisser la poignée vers le bas pour fermer une feuille.
  for (const sheet of document.querySelectorAll('.sheet')) {
    const grab = sheet.querySelector('.grab')
    if (!grab) continue
    let startY = null
    let dy = 0
    const spring = () => {
      sheet.style.transition = 'transform .18s ease'
      sheet.style.transform = ''
      setTimeout(() => { sheet.style.transition = '' }, 200)
      startY = null
      dy = 0
    }
    grab.addEventListener('pointerdown', (event) => {
      startY = event.clientY
      dy = 0
      sheet.style.transition = 'none'
      grab.setPointerCapture?.(event.pointerId)
    })
    grab.addEventListener('pointermove', (event) => {
      if (startY === null) return
      dy = Math.max(0, event.clientY - startY)
      sheet.style.transform = `translateY(${dy}px)`
      event.preventDefault()
    })
    const finish = () => {
      if (startY === null) return
      if (dy > 90) {
        sheet.style.transition = 'transform .16s ease'
        sheet.style.transform = 'translateY(105%)'
        setTimeout(() => {
          sheet.classList.add('hidden')
          sheet.style.transform = ''
          sheet.style.transition = ''
        }, 160)
        startY = null
        dy = 0
      } else {
        spring()
      }
    }
    grab.addEventListener('pointerup', finish)
    grab.addEventListener('pointercancel', finish)
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('.sheet, #targetBtn, .spark, .chart-big, .guest, #keys')) return
    closeSheets()
  })

  async function renderSettings() {
    const container = $('settings')
    container.innerHTML = '<p class="empty">Chargement…</p>'

    const [sys, me, authSessions] = await Promise.all([
      api('/api/system').then((r) => r.json()).catch(() => null),
      api('/api/me').then((r) => r.json()).catch(() => null),
      api('/api/auth-sessions').then((r) => r.json()).catch(() => ({ sessions: [] })),
    ])

    const sessionRows = (authSessions.sessions || []).map((s) => `
      <div class="session-row">
        <div class="top-line">
          <span><b>${escapeHtml(s.user || 'inconnu')}</b>
            ${s.current ? '<span class="badge-self">cette session</span>' : ''}</span>
          <button class="revoke" data-revoke="${escapeHtml(s.id)}">${T('settings.disconnect')}</button>
        </div>
        <div class="meta">
          ${escapeHtml(s.ip || '—')} · vue ${fmtAgo(s.lastSeen)} · ouverte ${fmtAgo(s.created)}<br>
          ${escapeHtml((s.ua || '').slice(0, 70))}
        </div>
      </div>`).join('')

    container.innerHTML = `
      <div class="card">
        <div class="card-head"><span class="title">${T('settings.sessions')}</span><span class="sub">${(authSessions.sessions || []).length} ${T('settings.active')}</span></div>
        ${sessionRows || `<p class="empty">${T('settings.none')}</p>`}
        <p class="hint">${T('settings.revokeHint')}</p>
      </div>

      <div class="card">
        <div class="card-head"><span class="title">${T('settings.connection')}</span></div>
        <div class="kv"><span>${T('settings.user')}</span><b>${escapeHtml(me?.user || '—')}</b></div>
        <div class="kv"><span>${T('settings.proxmox')}</span><b>${me?.proxmox ? escapeHtml(state.pveHost || 'configuré') : 'non configuré'}</b></div>
        <div class="kv"><span>${T('settings.pveShell')}</span><b>${
          state.sshConfigured ? T('settings.configured')
            : `<a href="#" id="sshSetupLink" style="color:var(--blue)">${T('settings.toConfigure')}</a>`
        }</b></div>
        <div class="row" style="margin-top:8px">
          <input id="pveHost" placeholder="${T('settings.pveHost')}" autocapitalize="none" spellcheck="false"
                 value="${escapeHtml(me?.proxmox ? state.pveHost || '' : '')}">
          <button id="pveSave">${T('settings.save')}</button>
        </div>
        <div class="kv"><span>${T('settings.server')}</span><b>${escapeHtml(sys?.hostname || '—')}</b></div>
        <div class="kv"><span>${T('settings.version')}</span><b>v${escapeHtml(sys?.version || '—')}</b></div>
        <div class="kv"><span>${T('settings.client')}</span><b>v${escapeHtml(clientVersion())}${
          sys && clientVersion() !== sys.version ? ' (recharge la page)' : ''
        }</b></div>
        <form method="post" action="/logout" style="margin-top:10px">
          <button type="submit" style="color:var(--red);background:none;border:0;font:inherit;padding:4px 0">${T('settings.logout')}</button>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><span class="title">${T('settings.display')}</span></div>
        <div class="switch-row">
          <span>${T('settings.language')}</span>
          <select id="langSelect" style="font: inherit; font-size: 12px; padding: 3px 6px">
            <option value="fr" ${window.getLang?.() === 'fr' ? 'selected' : ''}>Français</option>
            <option value="en" ${window.getLang?.() === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>
        <div class="switch-row">
          <span>${T('settings.fontSize')}</span>
          <span class="stepper">
            <button id="fontMinus">−</button>
            <span class="val" id="fontVal">${state.fontSize}</span>
            <button id="fontPlus">+</button>
          </span>
        </div>
        <div class="switch-row">
          <span>${T('settings.fullscreen')}</span>
          <button id="fsBtn" class="val" style="background:none;border:0;color:var(--blue);font:inherit">activer</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="title">${T('settings.container')}</span></div>
        <div class="kv"><span>${T('settings.load')}</span><b>${sys ? sys.load[0].toFixed(2) + ' / ' + sys.cpus + ' cpu' : '—'}</b></div>
        <div class="kv"><span>${T('settings.memory')}</span><b>${sys ? fmtBytes(sys.mem.total - sys.mem.free) + ' / ' + fmtBytes(sys.mem.total) : '—'}</b></div>
        <div class="kv"><span>${T('settings.disk')}</span><b>${sys?.disk ? fmtBytes(sys.disk.total - sys.disk.free) + ' / ' + fmtBytes(sys.disk.total) : '—'}</b></div>
        <div class="kv"><span>${T('settings.uptime')}</span><b>${sys ? fmtUptime(sys.uptime) : '—'}</b></div>
      </div>`

    $('pveSave').onclick = async () => {
      const host = $('pveHost').value.trim()
      if (!host) { toast('Indique l\'IP ou le nom du nœud Proxmox'); return }
      const res = await api('/api/pve/config', { method: 'POST', body: JSON.stringify({ host }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { toast(body.error || 'refusé'); return }
      state.pveHost = body.host
      state.proxmox = true
      if ((me?.user || '') === 'local') {
        toast('Hôte enregistré — reconnecte-toi avec root@pam')
        const form = document.createElement('form')
        form.method = 'post'
        form.action = '/logout'
        document.body.append(form)
        setTimeout(() => form.submit(), 900)
      } else {
        toast('Hôte enregistré — reconnecte-toi pour l\'appliquer')
        renderSettings()
      }
    }

    const sshLink = $('sshSetupLink')
    if (sshLink) sshLink.onclick = (event) => { event.preventDefault(); openSshSetup() }

    const langSelect = $('langSelect')
    if (langSelect) {
      langSelect.onchange = () => {
        window.setLang?.(langSelect.value)
        renderSettings()
      }
    }

    $('fontMinus').onclick = () => setFontSize(state.fontSize - 1)
    $('fontPlus').onclick = () => setFontSize(state.fontSize + 1)
    $('fsBtn').onclick = toggleFullscreen

    container.querySelectorAll('[data-revoke]').forEach((button) => {
      button.onclick = async () => {
        const id = button.dataset.revoke
        if (!confirm('Déconnecter cette session ?')) return
        const res = await api(`/api/auth-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        const body = await res.json().catch(() => ({}))
        if (body.self) { location.href = '/login'; return }
        toast(T('settings.revokeHint') ? 'Session révoquée' : 'ok')
        renderSettings()
      }
    })
  }

  function setFontSize(size) {
    state.fontSize = Math.min(22, Math.max(10, size))
    localStorage.setItem('sd.fontSize', String(state.fontSize))
    term.options.fontSize = state.fontSize
    const val = $('fontVal')
    if (val) val.textContent = state.fontSize
    fitAndSend()
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      $('fsBtn').textContent = 'activer'
    } else if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {})
      $('fsBtn').textContent = 'quitter'
    }
    setTimeout(fitAndSend, 300)
  }

  $('overlayBtn').onclick = () => { state.retries = 0; hideOverlay(); connect() }
  $('overlayAlt').onclick = () => { hideOverlay(); openConsole({ kind: 'local', session: state.session }) }

  fetch('/api/me')
    .then((res) => {
      if (res.status === 401) { location.href = '/login'; return null }
      return res.json()
    })
    .then((me) => {
      if (!me) return
      state.proxmox = Boolean(me.proxmox)
      state.user = me.user
      $('hostname').textContent = me.hostname
      return fetch('/api/auth-mode')
        .then((r) => r.json())
        .then((info) => {
          state.pveHost = info.host
          state.sshConfigured = Boolean(info.ssh?.configured)
          if (state.proxmox && info.host && state.sshConfigured) {
            setTarget({ kind: 'host' })
          } else {
            setTarget({ kind: 'local', session: state.session })
          }
          connect()
        })
        .catch(() => connect())
    })
    .catch(() => showOverlay('Serveur injoignable', 'Vérifie que le service tourne et que tu es sur le bon réseau.'))

  let resizeTimer
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(fitAndSend, 120)
  }
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', () => setTimeout(fitAndSend, 300))
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake()
      if (!state.alive) { state.retries = 0; connect() }
    }
  })

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

  window.SD = {
    api, toast, showView, openConsole, fmtBytes, fmtUptime, fmtAgo, escapeHtml, state,
    copyText: writeClipboard, renderSettings, closeSheets,
    typeText: (text) => sendOrQueue(String(text ?? '')),
  }

  // Lien profond : /?view=nodes, /?view=guests&guest=pve1|lxc|101
  const initialView = new URLSearchParams(location.search).get('view')
  if (['console', 'nodes', 'guests', 'files', 'settings'].includes(initialView)) showView(initialView)
})()
