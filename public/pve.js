(() => {
  const $ = (id) => document.getElementById(id)
  const SD = () => window.SD
  const T = (key, vars) => (window.t ? window.t(key, vars) : key)
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const state = { overview: null, at: 0, busy: false, guests: [], counts: {}, query: '', filter: 'all' }
  const OVERVIEW_TTL = 4000
  const TIMEFRAMES = [['hour', 'chart.hour'], ['day', 'chart.day'], ['week', 'chart.week'], ['month', 'chart.month']]

  const pct = (used, total) => (total > 0 ? Math.min(100, (used / total) * 100) : 0)
  const level = (value) => (value >= 90 ? 'crit' : value >= 75 ? 'warn' : '')

  function gauge(label, used, total, text) {
    const value = pct(used, total)
    return `<div class="gauge">
      <div class="line"><span>${esc(label)}</span><b>${esc(text || `${value.toFixed(0)} %`)}</b></div>
      <div class="bar"><span class="${level(value)}" style="width:${value.toFixed(1)}%"></span></div>
    </div>`
  }

  function points(rrd) {
    return (rrd || [])
      .filter((p) => Number.isFinite(p.cpu))
      .map((p) => ({ t: Number(p.time) * 1000, v: Math.max(0, Math.min(1, p.cpu)) }))
  }

  function drawChart(canvas, data, { color = '#e57000', cursor = null } = {}) {
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth || 300
    const height = canvas.clientHeight || 54
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (data.length < 2) return

    const max = Math.max(0.05, ...data.map((p) => p.v))
    const pad = 4
    const x = (i) => pad + (i * (width - pad * 2)) / (data.length - 1)
    const y = (v) => height - pad - (v / max) * (height - pad * 2)

    ctx.strokeStyle = 'rgba(0,0,0,.06)'
    ctx.lineWidth = 1
    for (let g = 1; g <= 3; g++) {
      const gy = pad + (g * (height - pad * 2)) / 4
      ctx.beginPath()
      ctx.moveTo(pad, gy)
      ctx.lineTo(width - pad, gy)
      ctx.stroke()
    }

    ctx.beginPath()
    data.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.v)) : ctx.lineTo(x(i), y(p.v))))
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.lineTo(width - pad, height - pad)
    ctx.lineTo(pad, height - pad)
    ctx.closePath()
    ctx.fillStyle = 'rgba(229,112,0,.13)'
    ctx.fill()

    if (cursor !== null && cursor >= 0 && cursor < data.length) {
      const cx = x(cursor)
      ctx.strokeStyle = 'rgba(47,59,71,.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, pad)
      ctx.lineTo(cx, height - pad)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx, y(data[cursor].v), 3.2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
  }

  async function openChart({ scope, node, type, vmid, label }) {
    const sheet = $('chartSheet')
    const body = $('chartBody')
    if (!sheet || !body) return
    sheet.classList.remove('hidden')
    let timeframe = 'hour'
    let data = []

    const url = () => scope === 'node'
      ? `/api/pve/nodes/${encodeURIComponent(node)}?timeframe=${timeframe}`
      : `/api/pve/guests/${encodeURIComponent(node)}/${type}/${vmid}?timeframe=${timeframe}`

    body.innerHTML = `
      <h3>${esc(label || node)}</h3>
      <div class="chart-tabs">${TIMEFRAMES.map(([key, name]) =>
        `<button data-tf="${key}" class="${key === timeframe ? 'active' : ''}">${T(name)}</button>`).join('')}</div>
      <canvas class="chart-big" id="bigChart"></canvas>
      <div class="chart-readout"><span id="chartTime">${T('chart.value')}</span><b id="chartValue"></b></div>
      <p class="hint" id="chartError"></p>`

    const canvas = $('bigChart')
    let cursor = null

    function paint() {
      drawChart(canvas, data, { cursor })
      if (cursor !== null && data[cursor]) {
        $('chartTime').textContent = new Date(data[cursor].t).toLocaleString('fr-FR', {
          weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        })
        $('chartValue').textContent = `${(data[cursor].v * 100).toFixed(1)} % CPU`
      }
    }

    async function load() {
      $('chartError').textContent = ''
      const res = await SD().api(url())
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { $('chartError').textContent = json.error || 'erreur'; return }
      data = points(json.rrd)
      cursor = null
      requestAnimationFrame(paint)
    }

    function pick(event) {
      if (!data.length) return
      const rect = canvas.getBoundingClientRect()
      const x = (event.clientX ?? 0) - rect.left
      const ratio = Math.max(0, Math.min(1, (x - 4) / (rect.width - 8)))
      cursor = Math.round(ratio * (data.length - 1))
      paint()
    }

    canvas.addEventListener('pointerdown', pick)
    canvas.addEventListener('pointermove', (event) => { if (event.buttons) pick(event) })
    body.querySelectorAll('[data-tf]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation()
        timeframe = button.dataset.tf
        body.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('active', b === button))
        load()
      }
    })

    await load()
  }

  async function loadOverview(force = false) {
    if (state.busy) return state.overview
    if (!force && state.overview && Date.now() - state.at < OVERVIEW_TTL) return state.overview
    state.busy = true
    try {
      const res = await SD().api('/api/pve/overview')
      if (res.status === 503) {
        state.overview = null
        return null
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'erreur API')
      state.overview = data
      state.at = Date.now()
      return data
    } finally {
      state.busy = false
    }
  }

  function renderSetup(container) {
    container.innerHTML = `
      <div class="card">
        <div class="card-head"><span class="title">Connecter Proxmox</span></div>
        <p class="hint">L'hôte Proxmox suffit pour se connecter avec les identifiants Proxmox
        (l'installateur le renseigne automatiquement). Le jeton d'API et la clé SSH sont
        facultatifs : ils servent aux shells de conteneurs.</p>
        <div id="setupBody" class="hint">Chargement…</div>
      </div>`
    SD().api('/api/pve/setup').then((res) => res.json()).then((info) => {
      const key = info.sshPublicKey
      $('setupBody').innerHTML = `
        <b>1.</b> Sur le nœud Proxmox, en root :<br>
        <code style="display:block;word-break:break-all;background:#f4f4f4;border:1px solid #e0e0e0;padding:8px;border-radius:3px;margin:6px 0">
          bash proxmox-setup.sh '${esc(key || '<clé publique>')}'
        </code>
        <b>2.</b> Dans ce conteneur (l'hôte seul suffit pour la connexion) :<br>
        <code style="display:block;word-break:break-all;background:#f4f4f4;border:1px solid #e0e0e0;padding:8px;border-radius:3px;margin:6px 0">
          npm run setup:pve -- --host 192.168.1.10
        </code>
        <b>3.</b> Redémarre le service : <code>systemctl restart serverdeck</code>`
    }).catch(() => { $('setupBody').textContent = 'Impossible de lire la configuration.' })
  }

  async function renderNodes() {
    const container = $('nodesList')
    const data = await loadOverview().catch((err) => ({ error: err.message }))
    if (!data) return renderSetup(container)
    if (data.error) {
      container.innerHTML = `<p class="empty">Proxmox injoignable.<br>${esc(data.error)}</p>`
      return
    }
    const nodes = data.nodes || []
    if (!nodes.length) {
      container.innerHTML = '<p class="empty">Aucun nœud retourné par l\'API.</p>'
      return
    }
    container.innerHTML = nodes.map((node) => {
      const online = node.status === 'online'
      return `<div class="card" data-node="${esc(node.node)}">
        <div class="card-head">
          <span class="title">${esc(node.node)}</span>
          <span class="pill ${online ? 'online' : 'offline'}">${online ? T('nodes.online') : esc(node.status || T('nodes.offline'))}</span>
        </div>
        ${gauge('CPU', node.cpu || 0, 1, `${((node.cpu || 0) * 100).toFixed(0)} % · ${node.maxcpu || 0} cœurs`)}
        ${gauge('Mémoire', node.mem || 0, node.maxmem || 0, `${SD().fmtBytes(node.mem)} / ${SD().fmtBytes(node.maxmem)}`)}
        ${gauge('Disque local', node.disk || 0, node.maxdisk || 0, `${SD().fmtBytes(node.disk)} / ${SD().fmtBytes(node.maxdisk)}`)}
        <div class="kv"><span>${T('nodes.uptime')}</span><b>${SD().fmtUptime(node.uptime)}</b></div>
        <div class="kv"><span>${T('nodes.guests')}</span><b>${(data.guests || []).filter((g) => g.node === node.node).length}</b></div>
        <canvas class="spark" data-spark="${esc(node.node)}"></canvas>
        <p class="hint" style="margin-top:4px">${T('nodes.chartHint')}</p>
        <div class="node-tools">
          <button type="button" data-node-tasks="${esc(node.node)}">${T('nodes.tasks')} <span class="badge" data-node-count="${esc(node.node)}"></span></button>
          <button type="button" data-node-log="${esc(node.node)}">${T('nodes.syslog')}</button>
          <button type="button" data-node-tpl="${esc(node.node)}">${T('nodes.templates')}</button>
          <button type="button" data-node-power="${esc(node.node)}" class="danger-btn">${T('nodes.power')}</button>
        </div>
      </div>`
    }).join('')

    for (const node of nodes) {
      SD().api(`/api/pve/nodes/${encodeURIComponent(node.node)}`).then((res) => res.json()).then((detail) => {
        const canvas = container.querySelector(`[data-spark="${CSS.escape(node.node)}"]`)
        if (!canvas) return
        const series = points(detail.rrd)
        if (series.length) drawChart(canvas, series)
        canvas.onclick = (event) => {
          event.stopPropagation()
          openChart({ scope: 'node', node: node.node, label: node.node })
        }
        if (detail.status?.pveversion) {
          const card = canvas.closest('.card')
          const row = document.createElement('div')
          row.className = 'kv'
          row.innerHTML = `<span>${T('nodes.version')}</span><b>${esc(String(detail.status.pveversion).split('/').pop())}</b>`
          card.insertBefore(row, canvas)
        }
      }).catch(() => {})
    }

    container.querySelectorAll('[data-node-tasks]').forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); openTasks(button.dataset.nodeTasks) }
    })
    container.querySelectorAll('[data-node-log]').forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); openSyslog(button.dataset.nodeLog) }
    })
    container.querySelectorAll('[data-node-tpl]').forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); openTemplates(button.dataset.nodeTpl) }
    })
    container.querySelectorAll('[data-node-power]').forEach((button) => {
      button.onclick = (event) => { event.stopPropagation(); openNodePower(button.dataset.nodePower) }
    })

    for (const node of nodes) {
      SD().api(`/api/pve/tasks/${encodeURIComponent(node.node)}?limit=50`)
        .then((res) => res.json())
        .then((data) => {
          const badge = container.querySelector(`[data-node-count="${CSS.escape(node.node)}"]`)
          if (!badge) return
          const running = (data.tasks || []).filter((task) => task.status === 'running').length
          badge.textContent = running ? String(running) : ''
          badge.classList.toggle('warn', running > 0)
        })
        .catch(() => {})
    }
  }

  async function renderGuests() {
    const container = $('guestsList')
    const data = await loadOverview().catch((err) => ({ error: err.message }))
    if (!data) return renderSetup(container)
    if (data.error) {
      container.innerHTML = `<p class="empty">Proxmox injoignable.<br>${esc(data.error)}</p>`
      return
    }
    const guests = data.guests || []
    if (!guests.length) {
      container.innerHTML = `<p class="empty">${T('guests.empty')}</p>`
      return
    }
    state.guests = guests
    state.counts = data.counts || {}

    if (!container.querySelector('#guestsTools')) {
      container.innerHTML = `
        <div class="guests-tools" id="guestsTools">
          <div class="row" style="margin:0">
            <input id="guestSearch" placeholder="${T('guests.search')}" autocapitalize="none" spellcheck="false" autocomplete="off">
            <button id="createGuest" class="chip-primary">+ ${T('guest.create')}</button>
          </div>
          <div class="chips" id="guestChips"></div>
        </div>
        <div id="guestRows"></div>`
      const search = $('guestSearch')
      search.value = state.query
      search.oninput = () => { state.query = search.value; paintGuestRows() }
      $('createGuest').onclick = (event) => { event.stopPropagation(); openCreate() }
      $('guestChips').onclick = (event) => {
        const button = event.target.closest('[data-filter]')
        if (!button) return
        state.filter = button.dataset.filter
        paintGuestRows()
      }
    }
    paintGuestRows()
  }

  function guestRow(g) {
    const running = g.status === 'running'
    const cpuPct = (g.cpu || 0) * 100
    const memPct = pct(g.mem, g.maxmem)
    return `<div class="guest" data-guest="${esc(g.node)}|${esc(g.type)}|${g.vmid}">
      <span class="st ${running ? 'running' : g.status === 'paused' ? 'paused' : ''}"></span>
      <span class="vmid">${g.vmid}</span>
      <span class="meta">
        <div class="nm">${esc(g.name)}${g.tags ? ` <span class="tag-chip">${esc(g.tags)}</span>` : ''}</div>
        <div class="sub">${g.type === 'lxc' ? 'LXC' : 'VM'} · ${running ? `${cpuPct.toFixed(0)} % cpu · ${SD().fmtBytes(g.mem)}` : 'arrêté'}${running && g.uptime ? ` · ${SD().fmtUptime(g.uptime)}` : ''}</div>
      </span>
      <span class="pill">${running ? `${memPct.toFixed(0)} %` : '—'}</span>
    </div>`
  }

  function paintGuestRows() {
    const rows = $('guestRows')
    if (!rows) return
    const all = state.guests || []
    const chips = $('guestChips')
    if (chips) {
      const filters = [
        ['all', T('guests.all'), all.length],
        ['lxc', 'LXC', all.filter((g) => g.type === 'lxc').length],
        ['qemu', 'VM', all.filter((g) => g.type === 'qemu').length],
        ['running', T('guests.runningOnly'), all.filter((g) => g.status === 'running').length],
        ['stopped', T('guests.stoppedOnly'), all.filter((g) => g.status !== 'running').length],
      ]
      chips.innerHTML = filters.map(([key, label, count]) =>
        `<button data-filter="${key}" class="${state.filter === key ? 'active' : ''}">${esc(label)} <span class="badge">${count}</span></button>`).join('')
    }
    const query = state.query.trim().toLowerCase()
    const filtered = all.filter((g) => {
      if (state.filter === 'lxc' && g.type !== 'lxc') return false
      if (state.filter === 'qemu' && g.type !== 'qemu') return false
      if (state.filter === 'running' && g.status !== 'running') return false
      if (state.filter === 'stopped' && g.status === 'running') return false
      if (!query) return true
      return `${g.vmid} ${g.name} ${g.tags || ''}`.toLowerCase().includes(query)
    })
    rows.innerHTML = filtered.length
      ? filtered.map(guestRow).join('')
      : `<p class="empty">${T('guests.noMatch')}</p>`
    for (const row of rows.querySelectorAll('[data-guest]')) {
      row.onclick = (event) => {
        event.stopPropagation()
        const [node, type, vmid] = row.dataset.guest.split('|')
        openGuest({ node, type, vmid })
      }
    }
  }


  const OPT_OSTYPES = ['debian', 'ubuntu', 'centos', 'fedora', 'alpine', 'archlinux', 'opensuse', 'gentoo', 'nixos', 'devuan', 'unmanaged']
  const OPT_ARCH = ['amd64', 'i386', 'arm64', 'armhf', 'riscv64']

  function optionsHtml(cfg) {
    const val = (key, fallback = '') => esc(cfg[key] ?? fallback)
    return `
      <div class="switch-row">
        <span>${T('guest.boot')}</span>
        <button class="toggle ${String(cfg.onboot ?? '0') === '1' ? 'on' : ''}" id="onbootSwitch"
          role="switch" aria-checked="${String(cfg.onboot ?? '0') === '1'}" aria-label="${T('guest.boot')}">
          <span class="knob"></span>
        </button>
      </div>
      <div class="opt-grid">
        <label>${T('guest.startup')}<input id="optStartup" value="${val('startup')}"
          placeholder="order=1,up=30,down=30" autocapitalize="none" spellcheck="false"></label>
        <label>${T('guest.system')}
          <select id="optOstype">${OPT_OSTYPES.map((o) =>
            `<option value="${o}" ${cfg.ostype === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label>${T('guest.arch')}
          <select id="optArch">${['', ...OPT_ARCH].map((a) =>
            `<option value="${a}" ${(cfg.arch || '') === a ? 'selected' : ''}>${a || '(défaut)'}</option>`).join('')}</select></label>
        <label>${T('guest.cores')}<input id="optCores" type="number" min="1" max="64" value="${val('cores')}"></label>
        <label>RAM (Mo)<input id="optMemory" type="number" min="16" max="1000000" value="${val('memory')}"></label>
        <label>Swap (Mo)<input id="optSwap" type="number" min="0" max="1000000" value="${val('swap')}"></label>
        <label>Hostname<input id="optHostname" value="${val('hostname')}" autocapitalize="none" spellcheck="false"></label>
        <label>${T('guest.tty')}<input id="optTty" type="number" min="1" max="6" value="${val('tty')}"></label>
        <label>${T('guest.cmode')}
          <select id="optCmode">${['', 'tty', 'console'].map((m) =>
            `<option value="${m}" ${(cfg.cmode || '') === m ? 'selected' : ''}>${m || '(défaut)'}</option>`).join('')}</select></label>
        <label>${T('guest.devConsole')}
          <select id="optConsole">${['', 'shell', 'console'].map((c) =>
            `<option value="${c}" ${(cfg.console || '') === c ? 'selected' : ''}>${c || '(défaut)'}</option>`).join('')}</select></label>
      </div>
      <label class="opt-desc">${T('guest.description')}
        <textarea id="optDescription" rows="2">${val('description')}</textarea></label>
      <p class="hint" id="optResult"></p>`
  }

  async function saveOptions(node, type, vmid, cfg) {
    const patch = {}
    const set = (id, key, value) => {
      const current = String(cfg[key] ?? '')
      if (value !== current && value !== '') patch[key] = value
    }
    set('optStartup', 'startup', document.getElementById('optStartup').value.trim())
    set('optOstype', 'ostype', document.getElementById('optOstype').value)
    set('optArch', 'arch', document.getElementById('optArch').value)
    set('optCores', 'cores', document.getElementById('optCores').value.trim())
    set('optMemory', 'memory', document.getElementById('optMemory').value.trim())
    set('optSwap', 'swap', document.getElementById('optSwap').value.trim())
    set('optHostname', 'hostname', document.getElementById('optHostname').value.trim())
    set('optTty', 'tty', document.getElementById('optTty').value.trim())
    set('optCmode', 'cmode', document.getElementById('optCmode').value)
    set('optConsole', 'console', document.getElementById('optConsole').value)
    set('optDescription', 'description', document.getElementById('optDescription').value)
    if (!Object.keys(patch).length) { SD().toast('Aucune modification'); return }
    const res = await SD().api(`/api/pve/guests/${encodeURIComponent(node)}/${type}/${vmid}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    const body = await res.json().catch(() => ({}))
    const out = document.getElementById('optResult')
    if (!res.ok) { if (out) out.textContent = body.error || 'refusé'; return }
    SD().toast('Options enregistrées')
    if (out) out.textContent = ''
  }

  async function openCreate() {
    const sheet = $('createSheet')
    const form = $('createForm')
    sheet.classList.remove('hidden')
    form.innerHTML = `<p class="empty">${T('guests.loading')}</p>`

    let overview
    try {
      overview = await loadOverview(true)
    } catch (err) {
      form.innerHTML = `<p class="empty">${esc(err.message)}</p>`
      return
    }
    const nodes = (overview?.nodes || []).map((n) => n.node)
    if (!nodes.length) {
      form.innerHTML = `<p class="empty">${T('guests.empty')}</p>`
      return
    }
    const node = nodes[0]

    let info
    try {
      const res = await SD().api(`/api/pve/templates/${encodeURIComponent(node)}`)
      info = await res.json()
      if (!res.ok) throw new Error(info.error || 'erreur API')
    } catch (err) {
      form.innerHTML = `<h3>${T('guest.create')}</h3><p class="empty">${esc(err.message)}</p>`
      return
    }
    const rootdir = (info.storages || []).filter((st) => String(st.content).includes('rootdir') || String(st.content).includes('images'))
    const diskStorages = rootdir.length ? rootdir : (info.storages || [])

    form.innerHTML = `
      <h3>${T('guest.create')}</h3>
      <div class="opt-grid">
        <label>Nœud<select id="cNode">${nodes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>
        <label>VMID<input id="cVmid" type="number" min="100" max="999999999" value="${info.nextVmid || 100}"></label>
        <label>Hostname<input id="cHost" value="serveur" autocapitalize="none" spellcheck="false"></label>
        <label>Modèle<select id="cTemplate">${(info.templates || []).map((t) =>
          `<option value="${esc(t.volid)}">${esc(t.volid.split('/').pop())}</option>`).join('')}</select></label>
        <label>Cœurs<input id="cCores" type="number" min="1" max="64" value="2"></label>
        <label>RAM (Mo)<input id="cMemory" type="number" min="16" max="1048576" value="1024"></label>
        <label>Swap (Mo)<input id="cSwap" type="number" min="0" max="1048576" value="512"></label>
        <label>Stockage disque<select id="cStorage">${diskStorages.map((st) =>
          `<option value="${esc(st.storage)}">${esc(st.storage)}</option>`).join('')}</select></label>
        <label>Disque (Go)<input id="cDisk" type="number" min="1" max="1024" value="4"></label>
        <label>Bridge<input id="cBridge" value="vmbr0" autocapitalize="none" spellcheck="false"></label>
        <label>IPv4<select id="cIpMode"><option value="dhcp">DHCP</option><option value="static">Statique</option></select></label>
        <label>Adresse (CIDR)<input id="cIp" placeholder="192.168.1.50/24" autocapitalize="none" spellcheck="false"></label>
        <label>Passerelle<input id="cGw" placeholder="192.168.1.1" autocapitalize="none" spellcheck="false"></label>
        <label>Mot de passe root<input id="cPass" type="password" autocomplete="new-password"></label>
      </div>
      <div class="switch-row"><span>Démarrer après création</span>
        <button class="toggle on" id="cStart" role="switch" aria-checked="true"><span class="knob"></span></button></div>
      <div class="switch-row"><span>${T('guest.boot')}</span>
        <button class="toggle" id="cOnboot" role="switch" aria-checked="false"><span class="knob"></span></button></div>
      <div class="row"><button id="cSubmit" class="primary">${T('guest.create')}</button></div>
      <p class="hint" id="cResult"></p>`

    for (const id of ['cStart', 'cOnboot']) {
      $(id).onclick = (event) => {
        event.stopPropagation()
        const el = $(id)
        el.classList.toggle('on')
        el.setAttribute('aria-checked', el.classList.contains('on') ? 'true' : 'false')
      }
    }

    const switchNode = async (next) => {
      try {
        const res = await SD().api(`/api/pve/templates/${encodeURIComponent(next)}`)
        const data = await res.json()
        if (!res.ok) return
        $('cVmid').value = data.nextVmid || $('cVmid').value
        $('cTemplate').innerHTML = (data.templates || []).map((t) =>
          `<option value="${esc(t.volid)}">${esc(t.volid.split('/').pop())}</option>`).join('')
        const st = (data.storages || []).filter((x) => /rootdir|images/.test(String(x.content)))
        $('cStorage').innerHTML = (st.length ? st : data.storages || []).map((x) =>
          `<option value="${esc(x.storage)}">${esc(x.storage)}</option>`).join('')
      } catch {}
    }
    $('cNode').onchange = () => switchNode($('cNode').value)

    $('cSubmit').onclick = async () => {
      const staticIp = $('cIpMode').value === 'static'
      const payload = {
        node: $('cNode').value.trim(),
        vmid: $('cVmid').value.trim(),
        hostname: $('cHost').value.trim(),
        ostemplate: $('cTemplate').value,
        cores: $('cCores').value.trim(),
        memory: $('cMemory').value.trim(),
        swap: $('cSwap').value.trim(),
        storage: $('cStorage').value,
        disk: $('cDisk').value.trim(),
        bridge: $('cBridge').value.trim(),
        ip: staticIp ? $('cIp').value.trim() : 'dhcp',
        gw: staticIp ? $('cGw').value.trim() : '',
        password: $('cPass').value,
        start: $('cStart').classList.contains('on') ? 1 : 0,
        onboot: $('cOnboot').classList.contains('on') ? 1 : 0,
      }
      const out = $('cResult')
      out.textContent = ''
      $('cSubmit').disabled = true
      try {
        const res = await SD().api('/api/pve/lxc', { method: 'POST', body: JSON.stringify(payload) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'création refusée')
        SD().toast(`Conteneur ${payload.vmid} créé`)
        closeSheets()
        state.at = 0
        await renderGuests()
        openGuest({ node: payload.node, type: 'lxc', vmid: String(payload.vmid) })
      } catch (err) {
        out.textContent = err.message
      } finally {
        $('cSubmit').disabled = false
      }
    }
  }

  async function openGuest({ node, type, vmid }) {
    const sheet = $('guestSheet')
    const detail = $('guestDetail')
    sheet.classList.remove('hidden')
    detail.innerHTML = '<p class="empty">Chargement…</p>'

    let data
    try {
      const res = await SD().api(`/api/pve/guests/${encodeURIComponent(node)}/${type}/${vmid}`)
      data = await res.json()
      if (!res.ok) throw new Error(data.error || 'erreur API')
    } catch (err) {
      detail.innerHTML = `<h3>${esc(type.toUpperCase())} ${esc(vmid)}</h3><p class="empty">${esc(err.message)}</p>`
      return
    }

    const status = data.status || {}
    const cfg = data.config || {}
    const running = status.status === 'running'
    const isLxc = type === 'lxc'
    const onboot = String(cfg.onboot ?? '0') === '1'
    const memUsed = status.mem ?? 0
    const memTotal = status.maxmem ?? 0
    const name = status.name || `#${vmid}`

    detail.innerHTML = `
      <h3>${esc(name)} · ${isLxc ? 'LXC' : 'VM'} ${esc(vmid)}</h3>
      <div class="kv"><span>${T('guest.node')}</span><b>${esc(node)}</b></div>
      <div class="kv"><span>${T('guest.state')}</span><b>${running ? T('guest.running') : esc(status.status || 'arrêté')}</b></div>
      ${running ? `<div class="kv"><span>Uptime</span><b>${SD().fmtUptime(status.uptime)}</b></div>` : ''}
      ${running ? `<div class="kv"><span>${T('guest.processes')}</span><b>${esc(status.pids ?? '—')}</b></div>` : ''}
      ${cfg.cores || cfg.cpus ? `<div class="kv"><span>${T('guest.cores')}</span><b>${esc(cfg.cores || cfg.cpus)}</b></div>` : ''}
      ${cfg.memory ? `<div class="kv"><span>${T('guest.ram')}</span><b>${SD().fmtBytes(cfg.memory * 1024 * 1024)}</b></div>` : ''}
      ${cfg.ostype ? `<div class="kv"><span>${T('guest.system')}</span><b>${esc(cfg.ostype)}</b></div>` : ''}
      ${cfg.hostname ? `<div class="kv"><span>Hostname</span><b>${esc(cfg.hostname)}</b></div>` : ''}
      ${cfg.net0 ? `<div class="kv"><span>${T('guest.network')}</span><b>${esc(cfg.net0)}</b></div>` : ''}
      ${running ? gauge('CPU', status.cpu || 0, 1, `${((status.cpu || 0) * 100).toFixed(0)} %`) : ''}
      ${running && memTotal ? gauge('Mémoire', memUsed, memTotal, `${SD().fmtBytes(memUsed)} / ${SD().fmtBytes(memTotal)}`) : ''}

      ${optionsHtml(cfg)}

      <canvas class="spark" id="guestSpark" style="height:64px"></canvas>
      <p class="hint" style="margin-top:4px">${T('nodes.chartHint')}</p>

      <div class="detail-actions">
        ${isLxc && running ? `<button class="primary" data-act="shell">${T('guest.terminal')}</button>` : ''}
        ${!running ? `<button data-act="start">${T('guest.start')}</button>` : ''}
        ${running ? `<button data-act="shutdown">${T('guest.stop')}</button>` : ''}
        ${running ? `<button class="danger" data-act="stop">${T('guest.kill')}</button>` : ''}
        ${running ? `<button data-act="reboot">${T('guest.reboot')}</button>` : ''}
      </div>
      <p class="hint">${T('guest.privileges')}</p>

      <details class="opt-block" open>
        <summary>${T('guest.snapshots')}</summary>
        <div id="snapBody"><p class="empty">${T('guests.loading')}</p></div>
      </details>

      <details class="opt-block">
        <summary>${T('guest.disk')}</summary>
        <div id="diskBody"></div>
      </details>

      <details class="opt-block">
        <summary>${T('guest.backups')}</summary>
        <div id="backupBody"><p class="empty">${T('guests.loading')}</p></div>
      </details>

      <details class="opt-block">
        <summary>${T('guest.clone')}</summary>
        <div id="cloneBody"></div>
      </details>`

    const canvas = $('guestSpark')
    const series = points(data.rrd)
    if (canvas && series.length) {
      requestAnimationFrame(() => drawChart(canvas, series))
      canvas.onclick = (event) => {
        event.stopPropagation()
        openChart({ scope: 'guest', node, type, vmid, label: `${name} · ${vmid}` })
      }
    }

    $('optStartup').onchange = () => saveOptions(node, type, vmid, cfg)
    $('optOstype').onchange = () => saveOptions(node, type, vmid, cfg)
    $('optArch').onchange = () => saveOptions(node, type, vmid, cfg)
    $('optCmode').onchange = () => saveOptions(node, type, vmid, cfg)
    $('optConsole').onchange = () => saveOptions(node, type, vmid, cfg)
    for (const id of ['optCores', 'optMemory', 'optSwap', 'optHostname', 'optTty', 'optDescription']) {
      const el = $(id)
      el.addEventListener('change', () => saveOptions(node, type, vmid, cfg))
    }

    $('onbootSwitch').onclick = async (event) => {
      event.stopPropagation()
      const next = !$('onbootSwitch').classList.contains('on')
      $('onbootSwitch').classList.toggle('on', next)
      try {
        const res = await SD().api(`/api/pve/guests/${encodeURIComponent(node)}/${type}/${vmid}/config`, {
          method: 'PUT',
          body: JSON.stringify({ onboot: next ? 1 : 0 }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || 'refusé')
        SD().toast(next ? 'Démarrage au boot activé' : 'Démarrage au boot désactivé')
      } catch (err) {
        $('onbootSwitch').classList.toggle('on', !next)
        SD().toast(err.message)
      }
    }

    loadSnapshots({ node, type, vmid })
    renderDiskSection({ node, type, vmid, cfg })
    loadBackups({ node, type, vmid })
    renderCloneSection({ node, type, vmid })

    detail.querySelectorAll('[data-act]').forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation()
        const action = button.dataset.act
        if (action === 'shell') {
          sheet.classList.add('hidden')
          SD().openConsole({ kind: 'ct', vmid: Number(vmid), label: name })
          return
        }
        if (action === 'stop' && button.dataset.armed !== '1') {
          armConfirm(button, T('guest.confirmKill'), () => {})
          return
        }
        if (action === 'stop') {
          button.dataset.armed = ''
          button.classList.remove('confirm')
          button.textContent = T('guest.kill')
        }
        button.disabled = true
        try {
          const res = await SD().api(`/api/pve/guests/${encodeURIComponent(node)}/${type}/${vmid}/${action}`, { method: 'POST' })
          const body = await res.json()
          if (!res.ok) throw new Error(body.error || 'action refusée')
          SD().toast(`Action « ${action} » lancée`)
          state.at = 0
          setTimeout(() => { openGuest({ node, type, vmid }); renderGuests() }, 1200)
        } catch (err) {
          SD().toast(err.message)
        } finally {
          button.disabled = false
        }
      }
    })
  }

  // --- outils partagés -----------------------------------------------------

  const enc = (value) => encodeURIComponent(String(value ?? ''))
  const locale = () => ((window.getLang && window.getLang()) === 'en' ? 'en-GB' : 'fr-FR')
  const fmtWhen = (seconds) => (seconds
    ? new Date(seconds * 1000).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—')

  // Deux appuis plutôt qu'un confirm() : peu fiable en PWA iOS.
  function armConfirm(button, label, action) {
    if (button.dataset.armed === '1') {
      button.dataset.armed = ''
      button.classList.remove('confirm')
      button.textContent = button.dataset.armedLabel || button.textContent
      action()
      return
    }
    button.dataset.armed = '1'
    button.dataset.armedLabel = button.textContent
    button.classList.add('confirm')
    button.textContent = label
    setTimeout(() => {
      if (!button.isConnected || button.dataset.armed !== '1') return
      button.dataset.armed = ''
      button.classList.remove('confirm')
      button.textContent = button.dataset.armedLabel
    }, 3200)
  }

  // Suit une tâche Proxmox et prévient quand elle se termine (sauvegarde,
  // clone, instantané…) : plus besoin de rester sur l'écran.
  const watchedTasks = new Map()
  function watchTask(node, upid, label) {
    if (!upid || watchedTasks.has(upid)) return
    watchedTasks.set(upid, Date.now())
    let errors = 0
    const tick = async () => {
      const started = watchedTasks.get(upid)
      if (!started) return
      if (Date.now() - started > 30 * 60_000) {
        watchedTasks.delete(upid)
        return
      }
      try {
        const res = await SD().api(`/api/pve/tasks/${enc(node)}/${enc(upid)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          errors += 1
          if (errors >= 3) {
            watchedTasks.delete(upid)
            return
          }
        }
        if (res.ok && data.status?.status === 'stopped') {
          watchedTasks.delete(upid)
          const exit = String(data.status?.exitstatus || '')
          if (!exit || /^OK/i.test(exit) || /^WARN/i.test(exit)) SD().toast(`${label} · ${T('task.done')}`)
          else SD().toast(`${label} · ${exit}`, 6000)
          state.at = 0
          return
        }
      } catch {}
      setTimeout(tick, 2500)
    }
    setTimeout(tick, 2000)
  }

  function shortVol(volid) {
    const parts = String(volid || '').split('/')
    return parts[parts.length - 1] || volid
  }

  function diskList(cfg, type) {
    const disks = []
    if (type === 'lxc') {
      if (cfg.rootfs) disks.push({ id: 'rootfs', value: cfg.rootfs })
      for (const key of Object.keys(cfg)) {
        if (/^mp\d+$/.test(key)) disks.push({ id: key, value: cfg[key] })
      }
    } else {
      for (const key of Object.keys(cfg)) {
        if (/^(scsi|virtio|sata|ide)\d+$/.test(key)) disks.push({ id: key, value: cfg[key] })
      }
    }
    return disks
  }

  // --- instantanés ---------------------------------------------------------

  async function loadSnapshots({ node, type, vmid }) {
    const body = $('snapBody')
    if (!body) return
    const base = `/api/pve/guests/${enc(node)}/${type}/${vmid}/snapshots`
    let snapshots = []
    try {
      const res = await SD().api(base)
      const data = await res.json().catch(() => ({}))
      if (res.ok) snapshots = (data.snapshots || []).filter((snap) => snap.name !== 'current')
    } catch {}

    body.innerHTML = `
      <div class="snap-list">${snapshots.length ? snapshots.map((snap) => `
        <div class="snap-row">
          <span class="meta">
            <b>${esc(snap.name)}</b>
            <span class="sub">${esc(snap.description || '')}${snap.snaptime ? ` · ${fmtWhen(snap.snaptime)}` : ''}</span>
          </span>
          <button type="button" data-rollback="${esc(snap.name)}">${T('snap.rollback')}</button>
          <button type="button" data-drop="${esc(snap.name)}" class="danger-btn">✕</button>
        </div>`).join('') : `<p class="empty">${T('snap.none')}</p>`}</div>
      <div class="row">
        <input id="snapName" placeholder="${T('snap.name')}" autocapitalize="none" spellcheck="false" autocomplete="off">
        <button id="snapCreate" type="button">${T('snap.create')}</button>
      </div>
      <p class="hint">${T('snap.hint')}</p>`

    $('snapCreate').onclick = async (event) => {
      event.stopPropagation()
      const snapname = $('snapName').value.trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(snapname)) {
        SD().toast(T('snap.badName'), 3600)
        return
      }
      try {
        const res = await SD().api(base, { method: 'POST', body: JSON.stringify({ snapname }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'refusé')
        SD().toast(T('snap.created', { n: snapname }))
        watchTask(node, data.task, T('snap.created', { n: snapname }))
        loadSnapshots({ node, type, vmid })
      } catch (err) {
        SD().toast(err.message, 3600)
      }
    }

    for (const button of body.querySelectorAll('[data-rollback]')) {
      button.onclick = (event) => {
        event.stopPropagation()
        armConfirm(button, T('snap.confirm'), async () => {
          try {
            const res = await SD().api(`${base}/${enc(button.dataset.rollback)}/rollback`, { method: 'POST' })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'refusé')
            SD().toast(T('snap.rollingBack'))
            watchTask(node, data.task, T('snap.rollback'))
          } catch (err) {
            SD().toast(err.message, 3600)
          }
        })
      }
    }

    for (const button of body.querySelectorAll('[data-drop]')) {
      button.onclick = (event) => {
        event.stopPropagation()
        armConfirm(button, '✕', async () => {
          try {
            const res = await SD().api(`${base}/${enc(button.dataset.drop)}`, { method: 'DELETE' })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'refusé')
            SD().toast(T('snap.deleted'))
            loadSnapshots({ node, type, vmid })
          } catch (err) {
            SD().toast(err.message, 3600)
          }
        })
      }
    }
  }

  // --- disque --------------------------------------------------------------

  function renderDiskSection({ node, type, vmid, cfg }) {
    const body = $('diskBody')
    if (!body) return
    const disks = diskList(cfg, type)
    body.innerHTML = `
      ${disks.length
        ? disks.map((disk) => `<div class="kv"><span>${esc(disk.id)}</span><b class="mono">${esc(disk.value)}</b></div>`).join('')
        : `<p class="empty">${T('disk.none')}</p>`}
      ${disks.length ? `<div class="row">
        <select id="resizeDisk">${disks.map((disk) => `<option value="${esc(disk.id)}">${esc(disk.id)}</option>`).join('')}</select>
        <input id="resizeSize" placeholder="+2G" autocapitalize="none" spellcheck="false" autocomplete="off">
        <button id="resizeGo" type="button">${T('disk.resize')}</button>
      </div>` : ''}
      <p class="hint">${T('disk.hint')}</p>`

    const go = $('resizeGo')
    if (!go) return
    go.onclick = async (event) => {
      event.stopPropagation()
      const size = $('resizeSize').value.trim()
      if (!size) return
      go.disabled = true
      try {
        const res = await SD().api(`/api/pve/guests/${enc(node)}/${type}/${vmid}/resize`, {
          method: 'POST',
          body: JSON.stringify({ disk: $('resizeDisk').value, size }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'refusé')
        SD().toast(T('disk.launched'))
        watchTask(node, data.task, T('disk.resize'))
        setTimeout(() => openGuest({ node, type, vmid }), 1800)
      } catch (err) {
        SD().toast(err.message, 3600)
      } finally {
        go.disabled = false
      }
    }
  }

  // --- sauvegardes ---------------------------------------------------------

  async function backupStorages(node) {
    try {
      const res = await SD().api(`/api/pve/storages/${enc(node)}`)
      const data = await res.json().catch(() => ({}))
      return (data.storages || []).filter((st) => String(st.content || '').includes('backup'))
    } catch {
      return []
    }
  }

  async function loadBackups({ node, type, vmid }) {
    const body = $('backupBody')
    if (!body) return
    let backups = []
    try {
      const res = await SD().api(`/api/pve/backups/${enc(node)}?vmid=${enc(vmid)}`)
      const data = await res.json().catch(() => ({}))
      if (res.ok) backups = data.backups || []
    } catch {}
    const storages = await backupStorages(node)
    if (!$('backupBody')) return

    body.innerHTML = `
      <div class="snap-list">${backups.length ? backups.map((backup) => `
        <div class="snap-row">
          <span class="meta">
            <b>${esc(shortVol(backup.volid))}</b>
            <span class="sub">${SD().fmtBytes(backup.size)} · ${fmtWhen(backup.ctime)} · ${esc(backup.storage || '')}</span>
          </span>
          <button type="button" data-del="${esc(backup.volid)}" data-storage="${esc(backup.storage)}" class="danger-btn">✕</button>
        </div>`).join('') : `<p class="empty">${T('backup.none')}</p>`}</div>
      ${storages.length ? `<div class="row">
        <select id="backupStorage">${storages.map((st) => `<option value="${esc(st.storage)}">${esc(st.storage)}</option>`).join('')}</select>
        <select id="backupMode">
          <option value="snapshot">snapshot</option>
          <option value="suspend">suspend</option>
          <option value="stop">stop</option>
        </select>
        <button id="backupGo" type="button">${T('backup.run')}</button>
      </div>` : `<p class="hint">${T('backup.noStorage')}</p>`}
      <p class="hint">${T('backup.hint')}</p>`

    const go = $('backupGo')
    if (go) {
      go.onclick = async (event) => {
        event.stopPropagation()
        go.disabled = true
        try {
          const res = await SD().api(`/api/pve/guests/${enc(node)}/${type}/${vmid}/backup`, {
            method: 'POST',
            body: JSON.stringify({ storage: $('backupStorage').value, mode: $('backupMode').value }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'refusé')
          SD().toast(T('backup.launched'), 3600)
          watchTask(node, data.task, T('backup.run'))
          setTimeout(() => loadBackups({ node, type, vmid }), 4000)
        } catch (err) {
          SD().toast(err.message, 3600)
        } finally {
          go.disabled = false
        }
      }
    }

    for (const button of body.querySelectorAll('[data-del]')) {
      button.onclick = (event) => {
        event.stopPropagation()
        armConfirm(button, '✕', async () => {
          try {
            const res = await SD().api(
              `/api/pve/backups/${enc(node)}/${enc(button.dataset.storage)}/${enc(button.dataset.del)}`,
              { method: 'DELETE' },
            )
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'refusé')
            SD().toast(T('backup.deleted'))
            loadBackups({ node, type, vmid })
          } catch (err) {
            SD().toast(err.message, 3600)
          }
        })
      }
    }
  }

  // --- clonage -------------------------------------------------------------

  async function renderCloneSection({ node, type, vmid }) {
    const body = $('cloneBody')
    if (!body) return
    let nextVmid = ''
    let storages = []
    try {
      const res = await SD().api(`/api/pve/templates/${enc(node)}`)
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        nextVmid = data.nextVmid || ''
        storages = (data.storages || []).filter((st) => /rootdir|images/.test(String(st.content)))
      }
    } catch {}
    if (!$('cloneBody')) return

    body.innerHTML = `
      <div class="row" style="margin-top:0">
        <input id="cloneVmid" type="number" min="100" placeholder="${T('clone.vmid')}" value="${esc(nextVmid)}">
        <input id="cloneHost" placeholder="${T('clone.hostname')}" autocapitalize="none" spellcheck="false" autocomplete="off">
      </div>
      <div class="row">
        ${storages.length ? `<select id="cloneStorage"><option value="">${T('clone.sameStorage')}</option>${storages.map((st) => `<option value="${esc(st.storage)}">${esc(st.storage)}</option>`).join('')}</select>` : ''}
        <button id="cloneGo" type="button">${T('clone.run')}</button>
      </div>
      <p class="hint">${T('clone.hint')}</p>`

    $('cloneGo').onclick = async (event) => {
      event.stopPropagation()
      const target = $('cloneVmid').value.trim()
      if (!/^\d{2,9}$/.test(target)) {
        SD().toast(T('clone.badVmid'), 3600)
        return
      }
      $('cloneGo').disabled = true
      try {
        const res = await SD().api(`/api/pve/guests/${enc(node)}/${type}/${vmid}/clone`, {
          method: 'POST',
          body: JSON.stringify({
            vmid: target,
            hostname: $('cloneHost').value.trim(),
            storage: $('cloneStorage')?.value || '',
            full: true,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'refusé')
        SD().toast(T('clone.launched', { n: target }), 4000)
        watchTask(node, data.task, T('clone.run'))
        setTimeout(() => { state.at = 0; renderGuests() }, 2500)
      } catch (err) {
        SD().toast(err.message, 3600)
      } finally {
        $('cloneGo').disabled = false
      }
    }
  }

  // --- panneau générique : tâches, journal, modèles, nœud ------------------

  function openPanel(html) {
    const body = $('panelBody')
    if (!body) return
    body.innerHTML = html
    $('panelSheet').classList.remove('hidden')
  }

  async function openTasks(node) {
    openPanel(`<h3>${T('tasks.title')} · ${esc(node)}</h3><p class="empty">${T('guests.loading')}</p>`)
    let tasks = []
    try {
      const res = await SD().api(`/api/pve/tasks/${enc(node)}?limit=40`)
      const data = await res.json().catch(() => ({}))
      if (res.ok) tasks = data.tasks || []
    } catch {}
    openPanel(`
      <h3>${T('tasks.title')} · ${esc(node)}</h3>
      ${tasks.length ? tasks.map((task) => `
        <div class="task-row" data-upid="${esc(task.upid)}">
          <span class="pill ${task.status === 'running' ? 'warn' : task.status === 'OK' ? 'ok' : 'crit'}">${esc(task.status || '?')}</span>
          <span class="meta">
            <b>${esc(task.type || '?')}${task.id ? ` · ${esc(task.id)}` : ''}</b>
            <span class="sub">${fmtWhen(task.starttime)}</span>
          </span>
        </div>`).join('') : `<p class="empty">${T('tasks.none')}</p>`}
      <p class="hint">${T('tasks.hint')}</p>`)
    for (const row of $('panelBody').querySelectorAll('[data-upid]')) {
      row.onclick = (event) => {
        event.stopPropagation()
        openTask(node, row.dataset.upid)
      }
    }
  }

  async function openTask(node, upid) {
    openPanel(`<h3>${T('task.title')}</h3><p class="empty">${T('guests.loading')}</p>`)
    let data = {}
    try {
      const res = await SD().api(`/api/pve/tasks/${enc(node)}/${enc(upid)}`)
      data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'refusé')
    } catch (err) {
      openPanel(`<h3>${T('task.title')}</h3><p class="empty">${esc(err.message)}</p>`)
      return
    }
    const running = data.status?.status === 'running'
    openPanel(`
      <h3>${T('task.title')}</h3>
      <div class="kv"><span>${T('task.state')}</span><b>${esc(data.status?.status || '—')}</b></div>
      <div class="kv"><span>${T('task.exit')}</span><b>${esc(data.status?.exitstatus || '—')}</b></div>
      <pre class="log-pre">${esc((data.log || []).map((line) => line.t).join('\n') || T('task.noLog'))}</pre>
      <div class="row">
        <button id="taskRefresh" type="button">${T('task.refresh')}</button>
        ${running ? `<button id="taskStop" type="button" class="danger-btn">${T('task.stop')}</button>` : ''}
      </div>`)
    $('taskRefresh').onclick = (event) => {
      event.stopPropagation()
      openTask(node, upid)
    }
    if ($('taskStop')) {
      $('taskStop').onclick = (event) => {
        event.stopPropagation()
        armConfirm($('taskStop'), T('task.confirmStop'), async () => {
          try {
            const res = await SD().api(`/api/pve/tasks/${enc(node)}/${enc(upid)}`, { method: 'DELETE' })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || 'refusé')
            SD().toast(T('task.stopped'))
            setTimeout(() => openTask(node, upid), 1200)
          } catch (err) {
            SD().toast(err.message, 3600)
          }
        })
      }
    }
  }

  async function openSyslog(node) {
    openPanel(`<h3>${T('node.syslog')} · ${esc(node)}</h3><p class="empty">${T('guests.loading')}</p>`)
    let lines = []
    try {
      const res = await SD().api(`/api/pve/syslog/${enc(node)}?limit=300`)
      const data = await res.json().catch(() => ({}))
      if (res.ok) lines = data.lines || []
    } catch {}
    openPanel(`
      <h3>${T('node.syslog')} · ${esc(node)}</h3>
      <pre class="log-pre">${esc(lines.map((line) => line.t).join('\n') || T('node.noLog'))}</pre>
      <div class="row"><button id="logRefresh" type="button">${T('task.refresh')}</button></div>`)
    $('logRefresh').onclick = (event) => {
      event.stopPropagation()
      openSyslog(node)
    }
  }

  async function openTemplates(node) {
    openPanel(`<h3>${T('nodes.templates')} · ${esc(node)}</h3><p class="empty">${T('guests.loading')}</p>`)
    let info = { appliances: [], storages: [] }
    let installed = []
    try {
      const [res, res2] = await Promise.all([
        SD().api(`/api/pve/templates/available/${enc(node)}`),
        SD().api(`/api/pve/templates/${enc(node)}`),
      ])
      info = await res.json().catch(() => info)
      const data2 = await res2.json().catch(() => ({}))
      installed = data2.templates || []
    } catch {}

    const storages = info.storages || []
    openPanel(`
      <h3>${T('nodes.templates')} · ${esc(node)}</h3>
      ${storages.length ? `<div class="row" style="margin-top:0">
        <select id="tplStorage">${storages.map((st) => `<option value="${esc(st.storage)}">${esc(st.storage)}</option>`).join('')}</select>
      </div>` : `<p class="hint">${T('tpl.noStorage')}</p>`}
      <input id="tplSearch" placeholder="${T('tpl.search')}" autocapitalize="none" spellcheck="false" autocomplete="off" class="tpl-search">
      <div id="tplList"></div>
      <details class="opt-block">
        <summary>${T('tpl.installed')} (${installed.length})</summary>
        ${installed.length ? installed.map((tpl) => `<div class="kv"><span>${esc(String(tpl.volid).split('/').pop())}</span><b>${SD().fmtBytes(tpl.size)}</b></div>`).join('') : `<p class="empty">${T('tpl.none')}</p>`}
      </details>`)

    const paint = () => {
      const query = ($('tplSearch').value || '').trim().toLowerCase()
      const list = (info.appliances || [])
        .filter((app) => !query || `${app.package} ${app.version} ${app.os} ${app.section}`.toLowerCase().includes(query))
        .slice(0, 80)
      $('tplList').innerHTML = list.length ? list.map((app) => `
        <div class="snap-row">
          <span class="meta">
            <b>${esc(app.package || app.template)}</b>
            <span class="sub">${esc(app.os || '')} · ${esc(app.version || '')}${app.section ? ` · ${esc(app.section)}` : ''}</span>
          </span>
          <button type="button" data-tpl="${esc(app.template)}">${T('tpl.download')}</button>
        </div>`).join('') : `<p class="empty">${T('tpl.none')}</p>`

      for (const button of $('tplList').querySelectorAll('[data-tpl]')) {
        button.onclick = async (event) => {
          event.stopPropagation()
          const storage = $('tplStorage')?.value
          if (!storage) return
          button.disabled = true
          try {
            const res = await SD().api(`/api/pve/templates/${enc(node)}/download`, {
              method: 'POST',
              body: JSON.stringify({ storage, template: button.dataset.tpl }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'refusé')
            SD().toast(T('tpl.launched'), 3600)
            watchTask(node, data.task, T('tpl.download'))
          } catch (err) {
            SD().toast(err.message, 3600)
            button.disabled = false
          }
        }
      }
    }
    $('tplSearch').oninput = paint
    paint()
  }

  function openNodePower(node) {
    openPanel(`
      <h3>${T('node.power')} · ${esc(node)}</h3>
      <p class="hint">${T('node.powerWarn')}</p>
      <div class="row">
        <button id="nodeReboot" type="button">${T('node.reboot')}</button>
        <button id="nodeShutdown" type="button" class="danger-btn">${T('node.shutdown')}</button>
      </div>`)
    const send = (action, button) => {
      armConfirm(button, T('node.confirm'), async () => {
        try {
          const res = await SD().api(`/api/pve/nodes/${enc(node)}/power`, {
            method: 'POST',
            body: JSON.stringify({ action }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'refusé')
          SD().toast(action === 'reboot' ? T('node.rebooting') : T('node.shuttingDown'), 5000)
          watchTask(node, data.task, action === 'reboot' ? T('node.reboot') : T('node.shutdown'))
        } catch (err) {
          SD().toast(err.message, 3600)
        }
      })
    }
    $('nodeReboot').onclick = (event) => { event.stopPropagation(); send('reboot', $('nodeReboot')) }
    $('nodeShutdown').onclick = (event) => { event.stopPropagation(); send('shutdown', $('nodeShutdown')) }
  }

  async function refreshPve(view) {
    try {
      if (view === 'nodes') await renderNodes()
      if (view === 'guests') await renderGuests()
    } catch (err) {
      SD().toast(err.message)
    }
  }

  SD().refreshPve = refreshPve
  SD().openGuest = openGuest
  SD().openChart = openChart

  {
    const params = new URLSearchParams(location.search)
    const guest = params.get('guest')
    const view = SD().state.view
    if (view === 'nodes' || view === 'guests') setTimeout(() => refreshPve(view), 250)
    if (guest && guest.split('|').length === 3) {
      const [node, type, vmid] = guest.split('|')
      setTimeout(() => openGuest({ node, type, vmid }), 600)
    }
  }

  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    const view = SD().state.view
    if (view === 'nodes' || view === 'guests') refreshPve(view)
  }, 6000)
})()
