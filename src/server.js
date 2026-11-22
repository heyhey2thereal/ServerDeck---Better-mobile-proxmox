const crypto = require('crypto')
const express = require('express')
const http = require('http')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { WebSocketServer } = require('ws')

const configStore = require('./config')
const config = configStore.load()
const auth = require('./auth')
const term = require('./pty')
const ssh = require('./ssh')
const fileStoreFactory = require('./files')
const { createClient } = require('./proxmox')
const pkg = require('../package.json')

let pveConfigured = Boolean(config.proxmox && config.proxmox.host)
// Jeton d'API si présent ; sinon les appels utilisent le ticket de l'utilisateur connecté.
let pveToken = pveConfigured ? createClient(config.proxmox) : null

function reloadPve() {
  pveConfigured = Boolean(config.proxmox && config.proxmox.host)
  pveToken = pveConfigured ? createClient(config.proxmox) : null
  pveTickets.clear()
}
// Sessions actives (le cookie ne suffit pas : la déconnexion doit être réelle).
// Persistées sur disque pour survivre à un redémarrage du service.
const sessions = new Map()
const SESSIONS_FILE = path.join(path.dirname(configStore.CONFIG_PATH), 'sessions.json')
let sessionsSaveTimer = null

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
    for (const [sid, entry] of Object.entries(raw)) {
      if (entry && entry.exp > Date.now()) sessions.set(sid, entry)
    }
  } catch {}
}

function saveSessions() {
  clearTimeout(sessionsSaveTimer)
  sessionsSaveTimer = setTimeout(() => {
    try {
      const out = {}
      for (const [sid, entry] of sessions) {
        if (entry.exp > Date.now()) out[sid] = entry
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out), { mode: 0o600 })
    } catch (err) {
      console.warn(`[serverdeck] sessions non enregistrées : ${err.message}`)
    }
  }, 500)
  sessionsSaveTimer.unref?.()
}

loadSessions()
// Tickets Proxmox par session (droits de l'utilisateur, durée de vie 2 h côté PVE).
const pveTickets = new Map()

function clientFor(req) {
  if (!pveConfigured) return null
  const session = sessionOf(req)
  const entry = session?.sid ? pveTickets.get(session.sid) : null
  if (entry && entry.exp > Date.now()) {
    return createClient(config.proxmox, { ticket: entry.ticket, csrf: entry.csrf })
  }
  return pveToken
}

const PUBLIC = path.join(__dirname, '..', 'public')
const COOKIE = 'sd'

// Fichiers envoyés depuis le téléphone, stockés à côté de config.json : ils
// survivent aux mises à jour (l'installateur ne touche qu'au code).
const FILES_DIR = process.env.SERVERDECK_FILES || path.join(path.dirname(configStore.CONFIG_PATH), 'files')
const fileStore = fileStoreFactory.createStore({
  dir: FILES_DIR,
  maxBytes: Number(process.env.SERVERDECK_MAX_FILE_BYTES) || 512 * 1024 * 1024,
  secret: config.sessionSecret,
})

const limiter = new auth.RateLimiter(6, 10 * 60_000)
// Défis 2FA Proxmox en attente (le ticket partiel ne transite jamais par le client).
const pendingTfa = new Map()

const app = express()
app.disable('x-powered-by')
if (config.trustProxy) app.set('trust proxy', true)

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', config.allowFrame ? 'SAMEORIGIN' : 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  next()
})
app.use(express.urlencoded({ extended: false, limit: '16kb' }))
app.use(express.json({ limit: '64kb' }))

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https'
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecure(req),
    path: '/',
    maxAge: config.sessionHours * 3600_000,
  }
}

function sessionOf(req) {
  const token = auth.parseCookies(req.headers.cookie || '')[COOKIE]
  const session = auth.readSession(token, config.sessionSecret)
  if (!session || !session.sid) return null
  const entry = sessions.get(session.sid)
  if (!entry || entry.exp < Date.now()) {
    sessions.delete(session.sid)
    pveTickets.delete(session.sid)
    return null
  }
  entry.lastSeen = Date.now()
  return { ...session, user: entry.user, entry }
}

function authed(req) {
  return Boolean(sessionOf(req))
}

function issueSession(req, res, user, ticket = null) {
  const sid = crypto.randomBytes(18).toString('base64url')
  sessions.set(sid, {
    user,
    exp: Date.now() + config.sessionHours * 3600_000,
    created: Date.now(),
    lastSeen: Date.now(),
    ip: req.ip || req.socket.remoteAddress || null,
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
  })
  if (sessions.size > 500) {
    for (const [key, entry] of sessions) {
      if (entry.exp < Date.now()) {
        sessions.delete(key)
        pveTickets.delete(key)
      }
    }
  }
  saveSessions()
  if (ticket) {
    pveTickets.set(sid, {
      ticket: ticket.ticket,
      csrf: ticket.csrf,
      username: ticket.username,
      exp: Date.now() + 110 * 60_000,
    })
  }
  res.cookie(COOKIE, auth.createSessionToken(config.sessionSecret, config.sessionHours, user, sid), cookieOptions(req))
  res.redirect('/')
}

function requireAuth(req, res, next) {
  if (authed(req)) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'non authentifié' })
  return res.redirect('/login')
}

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || 'inconnu'
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: pkg.version })
})

app.get('/login', (req, res) => {
  if (authed(req)) return res.redirect('/')
  res.sendFile(path.join(PUBLIC, 'login.html'), { headers: { 'Cache-Control': 'no-store' } })
})

function sshReady() {
  // La clé peut être à l'emplacement par défaut même si le bloc ssh n'a pas été écrit.
  const explicit = config.proxmox?.ssh?.keyPath
  const fallback = path.join(os.homedir(), '.ssh', 'serverdeck_ed25519')
  for (const candidate of [explicit, fallback]) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return true
    } catch {}
  }
  return false
}

app.get('/api/auth-mode', (req, res) => {
  res.json({
    mode: pveConfigured ? 'proxmox' : 'local',
    host: config.proxmox?.host || null,
    allowLocal: pveConfigured && config.allowLocalLogin !== false,
    totp: Boolean(config.totpSecret),
    user: sessionOf(req)?.user || null,
    ssh: { configured: sshReady() },
  })
})

app.post('/login', async (req, res) => {
  const key = clientKey(req)
  const state = limiter.check(key)
  if (state.blocked) {
    return res.status(429).send('Trop de tentatives. Réessaie plus tard.')
  }

  const { mode = '', username = '', password = '', code = '', tfa = '' } = req.body || {}
  const useProxmox = pveConfigured && mode !== 'local'

  if (useProxmox) {
    try {
      if (tfa) {
        const pending = pendingTfa.get(String(tfa))
        pendingTfa.delete(String(tfa))
        if (!pending || pending.exp < Date.now()) return res.redirect(303, '/login?e=1')
        const result = await pveToken.login(pending.username, null, {
          code: String(code).trim(),
          challenge: pending.challenge,
        })
        if (result.needTfa) return res.redirect(303, '/login?e=1')
        limiter.reset(key)
        return issueSession(req, res, result.username, result)
      }

      const result = await pveToken.login(String(username).trim(), String(password))
      if (result.needTfa) {
        const nonce = crypto.randomBytes(18).toString('base64url')
        pendingTfa.set(nonce, {
          username: String(username).trim(),
          challenge: result.challenge,
          exp: Date.now() + 180_000,
        })
        if (pendingTfa.size > 200) pendingTfa.clear()
        return res.redirect(303, `/login?tfa=${nonce}`)
      }
      limiter.reset(key)
      return issueSession(req, res, result.username, result)
    } catch (err) {
      console.warn(`[serverdeck] connexion Proxmox refusée pour ${username || '?'} : ${err.message}`)
      limiter.fail(key)
      // 401 = identifiants refusés ; tout le reste = API injoignable (TLS, port, réseau).
      const code = err.status === 401 ? '1' : 'net'
      return res.redirect(303, `/login?e=${code}`)
    }
  }

  const ok = auth.verifyPassword(String(password), config.passwordHash) && auth.verifyTotp(config.totpSecret, code)
  if (!ok) {
    limiter.fail(key)
    return res.redirect(303, '/login?e=1')
  }
  limiter.reset(key)
  issueSession(req, res, 'local')
})

app.post('/logout', (req, res) => {
  const session = sessionOf(req)
  if (session?.sid) {
    sessions.delete(session.sid)
    pveTickets.delete(session.sid)
    saveSessions()
  }
  res.clearCookie(COOKIE, { path: '/' })
  res.redirect('/login')
})

app.get('/api/me', requireAuth, (req, res) => {
  const session = sessionOf(req)
  res.json({
    hostname: os.hostname(),
    user: session?.user || os.userInfo().username,
    systemUser: os.userInfo().username,
    totp: Boolean(config.totpSecret),
    proxmox: pveConfigured,
    version: pkg.version,
  })
})

app.get('/api/auth-sessions', requireAuth, (req, res) => {
  const current = sessionOf(req)
  const list = []
  for (const [sid, entry] of sessions) {
    if (entry.exp < Date.now()) continue
    list.push({
      id: sid.slice(0, 12),
      user: entry.user,
      created: entry.created,
      lastSeen: entry.lastSeen,
      expires: entry.exp,
      ip: entry.ip,
      ua: entry.ua,
      current: current?.sid === sid,
    })
  }
  list.sort((a, b) => b.lastSeen - a.lastSeen)
  res.json({ sessions: list })
})

app.delete('/api/auth-sessions/:id', requireAuth, (req, res) => {
  const prefix = String(req.params.id)
  const current = sessionOf(req)
  let removed = 0
  for (const sid of [...sessions.keys()]) {
    if (!sid.startsWith(prefix)) continue
    sessions.delete(sid)
    pveTickets.delete(sid)
    removed += 1
  }
  if (removed) saveSessions()
  const self = Boolean(current?.sid && current.sid.startsWith(prefix))
  if (self) res.clearCookie(COOKIE, { path: '/' })
  res.json({ ok: removed > 0, removed, self })
})

app.get('/api/system', requireAuth, (req, res) => {
  let disk = null
  try {
    const s = fs.statfsSync('/')
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
  } catch {}
  res.json({
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem: { total: os.totalmem(), free: os.freemem() },
    disk,
    version: pkg.version,
  })
})

app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    res.json({ sessions: await term.listSessions() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/sessions', requireAuth, async (req, res) => {
  const name = String((req.body || {}).name || '').trim()
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name)) {
    return res.status(400).json({ error: 'nom invalide (a-z, 0-9, -, _)' })
  }
  try {
    await term.ensureSession(name)
    res.json({ ok: true, name })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/sessions/:name', requireAuth, async (req, res) => {
  try {
    await term.killSession(req.params.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// --- Proxmox -------------------------------------------------------------

function requirePve(req, res) {
  if (!pveConfigured) {
    res.status(503).json({ error: 'Proxmox non configuré', code: 'PVE_NOT_CONFIGURED' })
    return false
  }
  if (!clientFor(req)) {
    res.status(401).json({ error: 'session Proxmox expirée — reconnecte-toi', code: 'PVE_SESSION' })
    return false
  }
  return true
}

function pveError(res, err) {
  const expired = err.status === 401
  const status = expired || err.status === 403 ? 403 : 502
  res.status(status).json({
    error: expired ? 'session Proxmox expirée — reconnecte-toi' : err.message,
    code: expired ? 'PVE_SESSION' : 'PVE_ERROR',
  })
}

// Enregistre l'hôte Proxmox depuis l'interface (aucun shell nécessaire).
app.post('/api/pve/config', requireAuth, (req, res) => {
  const body = req.body || {}
  const host = String(body.host || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,252}$/.test(host)) {
    return res.status(400).json({ error: 'hôte invalide (IP ou nom, sans http://)' })
  }
  const port = Number(body.port) || 8006
  if (port < 1 || port > 65535) return res.status(400).json({ error: 'port invalide' })
  const scheme = body.scheme === 'http' ? 'http' : 'https'
  const verifyTls = Boolean(body.verifyTls)

  configStore.save((raw) => {
    raw.proxmox = { ...(raw.proxmox || {}), host, port, scheme, verifyTls }
    delete raw.proxmox.cert
  })
  config.proxmox = { ...(config.proxmox || {}), host, port, scheme, verifyTls }
  delete config.proxmox.cert
  reloadPve()
  console.log(`[serverdeck] hôte Proxmox enregistré : ${scheme}://${host}:${port}`)
  res.json({ ok: true, host, port, scheme, verifyTls })
})

app.get('/api/pve/overview', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    res.json(await clientFor(req).overview())
  } catch (err) {
    pveError(res, err)
  }
})

app.get('/api/pve/check', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    const version = await clientFor(req).version()
    res.json({ ok: true, version: version?.version, release: version?.release, host: config.proxmox.host })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.get('/api/pve/nodes/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    const client = clientFor(req)
    const timeframe = ['hour', 'day', 'week', 'month'].includes(req.query.timeframe) ? req.query.timeframe : 'hour'
    const [status, rrd] = await Promise.all([
      client.nodeStatus(req.params.node),
      client.nodeRrd(req.params.node, timeframe).catch(() => []),
    ])
    res.json({ node: req.params.node, status, rrd: rrd || [] })
  } catch (err) {
    pveError(res, err)
  }
})

app.get('/api/pve/storages/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    res.json({ storages: (await clientFor(req).storages(req.params.node)) || [] })
  } catch (err) {
    pveError(res, err)
  }
})

app.get('/api/pve/tasks/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    res.json({ tasks: (await clientFor(req).tasks(req.params.node, 25)) || [] })
  } catch (err) {
    pveError(res, err)
  }
})

app.get('/api/pve/guests/:node/:type/:vmid', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const { node, type, vmid } = req.params
  if (!['lxc', 'qemu'].includes(type) || !/^\d{1,9}$/.test(vmid)) {
    return res.status(400).json({ error: 'paramètres invalides' })
  }
  try {
    const client = clientFor(req)
    const timeframe = ['hour', 'day', 'week', 'month'].includes(req.query.timeframe) ? req.query.timeframe : 'hour'
    const [status, guestConfig, rrd] = await Promise.all([
      client.guestStatus(node, type, vmid),
      client.guestConfig(node, type, vmid).catch(() => null),
      client.guestRrd(node, type, vmid, timeframe).catch(() => []),
    ])
    res.json({ node, type, vmid: Number(vmid), status, config: guestConfig, rrd: rrd || [] })
  } catch (err) {
    pveError(res, err)
  }
})

// Modèles disponibles (vztmpl) par nœud et stockage.
app.get('/api/pve/templates/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  try {
    const client = clientFor(req)
    const storages = await client.storages(req.params.node)
    const withTemplates = (storages || []).filter((st) => String(st.content || '').includes('vztmpl'))
    const lists = await Promise.all(withTemplates.map((st) =>
      client.storageContent(req.params.node, st.storage, 'vztmpl')
        .then((items) => (items || []).map((it) => ({ volid: it.volid, size: it.size, storage: st.storage })))
        .catch(() => [])))
    const templates = lists.flat().sort((a, b) => a.volid.localeCompare(b.volid))
    const next = await client.nextVmid().catch(() => null)
    res.json({
      templates,
      storages: (storages || []).map((st) => ({ storage: st.storage, type: st.type, content: st.content || '', avail: st.avail, total: st.total })),
      nextVmid: next,
    })
  } catch (err) {
    pveError(res, err)
  }
})

// Création d'un conteneur LXC avec les options habituelles de Proxmox.
app.post('/api/pve/lxc', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const body = req.body || {}
  const rules = {
    node: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/,
    vmid: /^[1-9]\d{1,8}$/,
    hostname: /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/,
    ostemplate: /^[a-zA-Z0-9._-]+:vztmpl\/[a-zA-Z0-9._+-]+\.tar\.[a-z]+$/,
    cores: /^[1-9]\d?$/,
    memory: /^[1-9]\d{1,6}$/,
    swap: /^\d{1,7}$/,
    storage: /^[a-zA-Z0-9._-]{1,32}$/,
    disk: /^[1-9]\d{0,3}$/,
    bridge: /^[a-zA-Z0-9._-]{1,32}$/,
    ip: /^(dhcp|(\d{1,3}\.){3}\d{1,3}\/\d{1,2})$/,
    gw: /^((\d{1,3}\.){3}\d{1,3})?$/,
    password: /^[\x20-\x7e]{0,64}$/,
  }
  for (const [key, rule] of Object.entries(rules)) {
    const value = String(body[key] ?? '')
    if (!rule.test(value)) return res.status(400).json({ error: `champ invalide : ${key}` })
  }
  const net0 = body.ip === 'dhcp'
    ? `name=eth0,bridge=${body.bridge},ip=dhcp`
    : `name=eth0,bridge=${body.bridge},ip=${body.ip}${body.gw ? `,gw=${body.gw}` : ''}`
  const params = {
    vmid: body.vmid,
    ostemplate: body.ostemplate,
    hostname: body.hostname,
    cores: body.cores,
    memory: body.memory,
    swap: body.swap,
    rootfs: `${body.storage}:${body.disk}`,
    net0,
    unprivileged: '1',
    features: 'nesting=1',
    onboot: body.onboot ? '1' : '0',
    start: body.start ? '1' : '0',
  }
  if (body.password) params.password = body.password
  try {
    const task = await clientFor(req).createLxc(body.node, params)
    console.log(`[serverdeck] création LXC ${body.vmid} sur ${body.node}`)
    res.json({ ok: true, task, vmid: Number(body.vmid) })
  } catch (err) {
    pveError(res, err)
  }
})

app.put('/api/pve/guests/:node/:type/:vmid/config', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const { node, type, vmid } = req.params
  if (!['lxc', 'qemu'].includes(type) || !/^\d{1,9}$/.test(vmid)) {
    return res.status(400).json({ error: 'paramètres invalides' })
  }
  const ALLOWED = {
    onboot: /^[01]$/,
    startup: /^[a-z0-9=,\s.;_-]{0,64}$/i,
    description: /^[\s\S]{0,2000}$/,
    cores: /^[1-9]\d?$/,
    memory: /^[1-9]\d{0,6}$/,
    swap: /^\d{1,7}$/,
    hostname: /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/,
    tty: /^[1-9]\d?$/,
    cmode: /^(tty|console)$/,
    console: /^(shell|console)$/,
    arch: /^(amd64|i386|arm64|armhf|riscv64)$/,
    ostype: /^(debian|ubuntu|centos|fedora|alpine|archlinux|opensuse|gentoo|nixos|devuan|unmanaged)$/,
  }
  const patch = {}
  for (const [key, value] of Object.entries(req.body || {})) {
    const rule = ALLOWED[key]
    if (!rule) continue
    const text = String(value).trim()
    if (!rule.test(text)) return res.status(400).json({ error: `valeur invalide pour ${key}` })
    patch[key] = text
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: `options modifiables : ${Object.keys(ALLOWED).join(', ')}` })
  }
  try {
    const task = await clientFor(req).guestSetConfig(node, type, vmid, patch)
    res.json({ ok: true, task })
  } catch (err) {
    pveError(res, err)
  }
})

// Actions réservées par des routes dédiées (instantanés, clone, disque,
// sauvegarde) : sans cette garde, « snapshots » serait pris pour une action
// de puissance et refusé par le client Proxmox.
const RESERVED_GUEST_POST = new Set(['snapshots', 'clone', 'resize', 'backup'])

app.post('/api/pve/guests/:node/:type/:vmid/:action', requireAuth, async (req, res, next) => {
  if (!requirePve(req, res)) return
  const { node, type, vmid, action } = req.params
  if (RESERVED_GUEST_POST.has(action)) return next()
  if (!['lxc', 'qemu'].includes(type) || !/^\d{1,9}$/.test(vmid)) {
    return res.status(400).json({ error: 'paramètres invalides' })
  }
  try {
    const task = await clientFor(req).guestAction(node, type, vmid, action)
    res.json({ ok: true, task })
  } catch (err) {
    pveError(res, err)
  }
})

app.get('/api/pve/setup', requireAuth, async (req, res) => {
  let publicKey = null
  if (config.proxmox?.ssh?.keyPath) publicKey = ssh.readPublicKey(config.proxmox.ssh.keyPath)
  res.json({
    configured: pveConfigured,
    host: config.proxmox?.host || null,
    port: config.proxmox?.port || 8006,
    verifyTls: config.proxmox?.verifyTls !== false,
    sshUser: config.proxmox?.ssh?.user || 'root',
    sshPublicKey: publicKey,
    authorizedKeys: publicKey
      ? `command="/usr/local/sbin/serverdeck-shell",no-port-forwarding,no-agent-forwarding,no-x11-forwarding ${publicKey}`
      : null,
  })
})

// --- Instantanés, clones, disque, sauvegardes, tâches, nœud -------------

function guestArgs(req, res) {
  const { node, type, vmid } = req.params
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(String(node))
    || !['lxc', 'qemu'].includes(type)
    || !/^\d{1,9}$/.test(String(vmid))) {
    res.status(400).json({ error: 'paramètres invalides' })
    return null
  }
  return { node, type, vmid }
}

function nodeArg(req, res) {
  const node = String(req.params.node || '')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(node)) {
    res.status(400).json({ error: 'nœud invalide' })
    return null
  }
  return node
}

// Instantanés d'un invité.
app.get('/api/pve/guests/:node/:type/:vmid/snapshots', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  try {
    res.json({ snapshots: (await clientFor(req).snapshots(args.node, args.type, args.vmid)) || [] })
  } catch (err) { pveError(res, err) }
})


app.post('/api/pve/guests/:node/:type/:vmid/snapshots', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  const body = req.body || {}
  try {
    const task = await clientFor(req).snapshotCreate(args.node, args.type, args.vmid, {
      snapname: String(body.snapname || '').trim(),
      description: String(body.description || ''),
    })
    res.json({ ok: true, task })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/pve/guests/:node/:type/:vmid/snapshots/:snap/rollback', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  try {
    res.json({ ok: true, task: await clientFor(req).snapshotRollback(args.node, args.type, args.vmid, req.params.snap) })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/pve/guests/:node/:type/:vmid/snapshots/:snap', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  try {
    res.json({ ok: true, task: await clientFor(req).snapshotDelete(args.node, args.type, args.vmid, req.params.snap) })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/pve/guests/:node/:type/:vmid/clone', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  const body = req.body || {}
  try {
    const task = await clientFor(req).cloneGuest(args.node, args.type, args.vmid, {
      vmid: String(body.vmid || '').trim(),
      hostname: String(body.hostname || '').trim(),
      storage: body.storage ? String(body.storage) : undefined,
      target: body.target ? String(body.target) : undefined,
      full: Boolean(body.full),
    })
    console.log(`[serverdeck] clone ${args.type}/${args.vmid} → ${body.vmid}`)
    res.json({ ok: true, task, vmid: Number(body.vmid) })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/pve/guests/:node/:type/:vmid/resize', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  const body = req.body || {}
  try {
    const task = await clientFor(req).resizeDisk(args.node, args.type, args.vmid, {
      disk: String(body.disk || 'rootfs'),
      size: String(body.size || '').trim(),
    })
    res.json({ ok: true, task })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/pve/guests/:node/:type/:vmid/backup', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const args = guestArgs(req, res)
  if (!args) return
  const body = req.body || {}
  try {
    const task = await clientFor(req).vzdump(args.node, {
      vmid: args.vmid,
      storage: String(body.storage || ''),
      mode: body.mode,
      compress: body.compress,
      notes: body.notes,
    })
    console.log(`[serverdeck] sauvegarde ${args.vmid} → ${body.storage}`)
    res.json({ ok: true, task })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/pve/backups/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  try {
    let backups = (await clientFor(req).backups(node)) || []
    if (req.query.vmid && /^\d{1,9}$/.test(String(req.query.vmid))) {
      backups = backups.filter((item) => String(item.vmid) === String(req.query.vmid))
    }
    res.json({ backups })
  } catch (err) { pveError(res, err) }
})

app.delete('/api/pve/backups/:node/:storage/:volid', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  try {
    await clientFor(req).deleteVolume(node, req.params.storage, req.params.volid)
    console.log(`[serverdeck] sauvegarde supprimée : ${req.params.volid}`)
    res.json({ ok: true })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/pve/tasks/:node/:upid', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  if (!/^UPID:[A-Za-z0-9:._-]{10,200}$/.test(String(req.params.upid))) {
    return res.status(400).json({ error: 'identifiant de tâche invalide' })
  }
  try {
    const client = clientFor(req)
    const [status, log] = await Promise.all([
      client.taskStatus(node, req.params.upid).catch(() => null),
      client.taskLog(node, req.params.upid, { start: 0, limit: 400 }).catch(() => []),
    ])
    res.json({ status, log: log || [] })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/pve/tasks/:node/:upid', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  if (!/^UPID:[A-Za-z0-9:._-]{10,200}$/.test(String(req.params.upid))) {
    return res.status(400).json({ error: 'identifiant de tâche invalide' })
  }
  try {
    await clientFor(req).taskStop(node, req.params.upid)
    res.json({ ok: true })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/pve/syslog/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  try {
    res.json({ lines: (await clientFor(req).syslog(node, req.query.limit)) || [] })
  } catch (err) { pveError(res, err) }
})

// Redémarrage / arrêt du nœud : action rare et lourde, l'interface demande
// deux appuis explicites.
app.post('/api/pve/nodes/:node/power', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  const action = String((req.body || {}).action || '')
  if (!['reboot', 'shutdown'].includes(action)) {
    return res.status(400).json({ error: 'action attendue : reboot ou shutdown' })
  }
  try {
    const task = await clientFor(req).nodePower(node, action)
    console.log(`[serverdeck] nœud ${node} : ${action}`)
    res.json({ ok: true, task })
  } catch (err) { pveError(res, err) }
})

// Modèles LXC : liste des appliances disponibles et téléchargement.
app.get('/api/pve/templates/available/:node', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  try {
    const client = clientFor(req)
    const [appliances, storages] = await Promise.all([
      client.aplinfo(node).catch(() => []),
      client.storages(node).catch(() => []),
    ])
    const targets = (storages || [])
      .filter((st) => String(st.content || '').includes('vztmpl'))
      .map((st) => ({ storage: st.storage, avail: st.avail, total: st.total }))
    res.json({ appliances: appliances || [], storages: targets })
  } catch (err) { pveError(res, err) }
})

app.post('/api/pve/templates/:node/download', requireAuth, async (req, res) => {
  if (!requirePve(req, res)) return
  const node = nodeArg(req, res)
  if (!node) return
  const body = req.body || {}
  try {
    const task = await clientFor(req).templateDownload(node, {
      storage: String(body.storage || ''),
      template: String(body.template || ''),
    })
    console.log(`[serverdeck] modèle ${body.template} → ${body.storage}`)
    res.json({ ok: true, task })
  } catch (err) {
    if (err.status) return pveError(res, err)
    res.status(400).json({ error: err.message })
  }
})

// --- Fichiers ------------------------------------------------------------

function fileError(res, err) {
  const status = err.status || 500
  if (status >= 500) console.warn(`[serverdeck] fichiers : ${err.message}`)
  if (!res.headersSent) res.status(status).json({ error: err.message })
}

app.get('/api/files', requireAuth, (req, res) => {
  const files = fileStore.list()
  res.json({
    files,
    total: files.reduce((sum, file) => sum + file.size, 0),
    max: fileStore.maxBytes,
    free: fileStore.free(),
  })
})

// Corps brut (application/octet-stream) : écrit sur disque au fil de l'eau,
// jamais en mémoire — le conteneur ne dispose que de 256 Mo de RAM.
app.put('/api/files/:name', requireAuth, (req, res) => {
  if (!/^application\/octet-stream/i.test(String(req.headers['content-type'] || ''))) {
    return res.status(415).json({ error: 'content-type attendu : application/octet-stream' })
  }
  let target
  try {
    target = fileStore.resolveName(req.params.name)
  } catch (err) {
    return fileError(res, err)
  }
  const declared = Number(req.headers['content-length'] || 0)
  const free = fileStore.free()
  if (declared && free !== null && free < declared + 32 * 1024 * 1024) {
    return res.status(507).json({ error: 'espace disque insuffisant dans le conteneur', code: 'NO_SPACE' })
  }
  fileStore.save(target.name, req, { declared })
    .then((file) => {
      console.log(`[serverdeck] fichier reçu : ${file.name} (${file.size} octets)`)
      res.json({ ok: true, file })
    })
    .catch((err) => fileError(res, err))
})

app.get('/api/files/:name', requireAuth, (req, res) => {
  const entry = fileStore.stat(req.params.name)
  if (!entry) return res.status(404).json({ error: 'fichier introuvable' })
  const { full } = fileStore.resolveName(req.params.name)
  res.type('application/octet-stream')
  res.download(full, entry.name, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } }, (err) => {
    if (err) fileError(res, err)
  })
})

app.delete('/api/files/:name', requireAuth, (req, res) => {
  try {
    fileStore.remove(req.params.name)
    res.json({ ok: true })
  } catch (err) {
    fileError(res, err)
  }
})

app.post('/api/files/:name/rename', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, file: fileStore.rename(req.params.name, (req.body || {}).name) })
  } catch (err) {
    fileError(res, err)
  }
})

// URL autonome pour un conteneur ou une VM (pas de cookie de session) :
// signée, liée au nom du fichier et limitée dans le temps.
app.get('/api/files/:name/link', requireAuth, (req, res) => {
  const entry = fileStore.stat(req.params.name)
  if (!entry) return res.status(404).json({ error: 'fichier introuvable' })
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168)
  const { token, exp } = fileStore.signToken(entry.name, hours * 3600_000)
  const base = (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
  res.json({
    name: entry.name,
    size: entry.size,
    exp,
    url: `${base}/d/${encodeURIComponent(entry.name)}?t=${token}`,
  })
})

app.get('/d/:name', (req, res) => {
  const name = fileStoreFactory.sanitizeName(req.params.name)
  if (!name || !fileStore.verifyToken(name, String(req.query.t || ''))) {
    return res.status(403).type('text/plain').send('lien invalide ou expiré')
  }
  const entry = fileStore.stat(name)
  if (!entry) return res.status(404).type('text/plain').send('fichier introuvable')
  const { full } = fileStore.resolveName(name)
  // Toujours en pièce jointe : un HTML envoyé ne doit jamais s'exécuter
  // dans l'origine de l'application.
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Robots-Tag', 'noindex')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.type('application/octet-stream')
  res.download(full, name)
})

app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm'), { maxAge: '30d' }))
app.use('/vendor/addon-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit'), { maxAge: '30d' }))
app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }))

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'), { headers: { 'Cache-Control': 'no-store' } })
})

const server = http.createServer(app)

const wss = new WebSocketServer({ noServer: true })
const activePtys = new Set()

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  if (!authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const name = url.searchParams.get('session') || 'main'
  const cols = Math.min(Math.max(Number(url.searchParams.get('cols')) || 80, 10), 500)
  const rows = Math.min(Math.max(Number(url.searchParams.get('rows')) || 24, 5), 200)

  const kind = url.searchParams.get('kind') || 'local'
  let proc
  try {
    if (kind === 'ct') {
      proc = ssh.spawnContainerShell(config.proxmox, url.searchParams.get('vmid'), { cols, rows })
    } else if (kind === 'host') {
      proc = ssh.spawnHostShell(config.proxmox, { cols, rows })
    } else {
      proc = term.attach(name, {
        cols,
        rows,
        shell: config.shell,
        cwd: config.cwd || os.homedir(),
      })
    }
  } catch (err) {
    ws.send(JSON.stringify({ t: 'error', m: err.message }))
    return ws.close()
  }

  // tmux purge la file d'entrée du tty au moment où il s'attache : on retient
  // les frappes arrivées avant le premier rendu, puis on les rejoue.
  let attached = false
  let flushScheduled = false
  let pendingBytes = 0
  const pending = []

  activePtys.add(proc)
  ws.on('close', () => activePtys.delete(proc))

  proc.onData((data) => {
    if (!flushScheduled) {
      flushScheduled = true
      setTimeout(() => {
        attached = true
        for (const chunk of pending.splice(0)) {
          try { proc.write(chunk) } catch {}
        }
        pendingBytes = 0
      }, 120)
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'd', d: data }))
  })
  proc.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'x', c: exitCode }))
      ws.close()
    }
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      if (attached) {
        proc.write(msg.d)
      } else if (pendingBytes < 4096) {
        pending.push(msg.d)
        pendingBytes += msg.d.length
      }
    }
    if (msg.t === 'r') {
      const c = Math.min(Math.max(Number(msg.c) || cols, 10), 500)
      const r = Math.min(Math.max(Number(msg.r) || rows, 5), 200)
      try { proc.resize(c, r) } catch {}
    }
    if (msg.t === 'p' && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'p' }))
  })

  ws.on('close', () => {
    try { proc.kill() } catch {}
  })
})

server.listen(config.port, config.bind, () => {
  console.log(`[serverdeck] http://${config.bind}:${config.port} (utilisateur ${os.userInfo().username})`)
  if (config.bind === '0.0.0.0' && !config.trustProxy) {
    console.log('[serverdeck] attention : écoute sur toutes les interfaces. Utilise Tailscale ou un reverse proxy TLS.')
  }
})

const shutdown = () => {
  clearTimeout(sessionsSaveTimer)
  try {
    const out = {}
    for (const [sid, entry] of sessions) {
      if (entry.exp > Date.now()) out[sid] = entry
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out), { mode: 0o600 })
  } catch {}
  for (const proc of activePtys) {
    try { proc.kill() } catch {}
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
