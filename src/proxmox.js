const fs = require('fs')
const https = require('https')
const http = require('http')

const CACHE_TTL = 3000

const NODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/
const GUEST_RE = /^\d{1,9}$/
const SNAP_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/
const DISK_RE = /^(rootfs|mp\d{1,3}|scsi\d{1,3}|virtio\d{1,3}|sata\d{1,3}|ide\d{1,3})$/
const SIZE_RE = /^\+?\d{1,4}(\.\d{1,2})?[KMGT]?$/

function checkNode(node) {
  if (!NODE_RE.test(String(node || ''))) throw new Error('nœud invalide')
  return encodeURIComponent(node)
}

function checkGuest(type, vmid) {
  if (!['lxc', 'qemu'].includes(type)) throw new Error(`type inconnu : ${type}`)
  if (!GUEST_RE.test(String(vmid))) throw new Error('vmid invalide')
  return `${type}/${vmid}`
}


// auth : null → jeton du fichier de config (ou aucun) ;
//        { ticket, csrf } → ticket de session Proxmox (droits de l'utilisateur).
function createClient(cfg, auth = null) {
  if (!cfg || !cfg.host) return null

  const secure = cfg.scheme !== 'http'
  const transport = secure ? https : http
  const useTicket = Boolean(auth && auth.ticket)
  const hasToken = Boolean(cfg.tokenId && cfg.tokenSecret)

  // Par défaut on n'épingle rien : le certificat Proxmox est souvent auto-signé ou
  // signé par l'autorité de cluster, et épingler la feuille casse la vérification.
  // Pour une vérification stricte : "verifyTls": true + "ca": "/chemin/pve-root-ca.pem".
  let agent
  if (!secure) {
    agent = new http.Agent({ keepAlive: true })
  } else {
    const options = { keepAlive: true }
    if (cfg.verifyTls === true) {
      options.rejectUnauthorized = true
      if (cfg.ca) options.ca = fs.readFileSync(cfg.ca)
      if (cfg.hostIsIp === false) options.servername = cfg.servername || undefined
    } else {
      options.rejectUnauthorized = false
    }
    agent = new https.Agent(options)
  }

  const cache = new Map()

  function authHeaders(method) {
    if (useTicket) {
      return {
        Cookie: `PVEAuthCookie=${auth.ticket}`,
        ...(method !== 'GET' ? { CSRFPreventionToken: auth.csrf || '' } : {}),
      }
    }
    if (hasToken) return { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` }
    return {}
  }

  function request(path, { method = 'GET', body = null, timeout = 8000, anonymous = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? new URLSearchParams(body).toString() : null
      const req = transport.request(
        {
          host: cfg.host,
          port: cfg.port || 8006,
          path: `/api2/json${path}`,
          method,
          agent,
          timeout,
          headers: {
            ...(anonymous ? {} : authHeaders(method)),
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { raw += chunk })
          res.on('end', () => {
            let parsed = null
            try { parsed = raw ? JSON.parse(raw) : null } catch {}
            if (res.statusCode >= 400) {
              const message = parsed?.errors
                ? Object.values(parsed.errors).join(' · ')
                : parsed?.message || `HTTP ${res.statusCode}`
              const err = new Error(message)
              err.status = res.statusCode
              return reject(err)
            }
            resolve(parsed?.data ?? null)
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('délai dépassé vers l\'API Proxmox')))
      req.on('error', (err) => {
        const hint = /self.signed|UNABLE_TO_VERIFY|certificate/i.test(err.message)
          ? ' (certificat : mets "verifyTls": false pour un certificat auto-signé)'
          : ''
        reject(new Error(`${err.message}${hint}`))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  async function cached(key, fn) {
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.value
    const value = await fn()
    cache.set(key, { value, expires: Date.now() + CACHE_TTL })
    return value
  }

  return {
    host: cfg.host,

    version: () => cached('version', () => request('/version')),

    // Authentification par identifiants Proxmox (PAM ou realm PVE).
    // Renvoie { ticket, csrf, username } ou { needTfa, challenge }.
    async login(username, password, tfa = null) {
      const body = { username, password }
      if (tfa) {
        body.password = tfa.code
        body['tfa-challenge'] = tfa.challenge
      }
      const data = await request('/access/ticket', { method: 'POST', body, anonymous: true })
      if (!data) throw new Error('réponse vide de Proxmox')
      if (data.NeedTFA) return { needTfa: true, challenge: data.ticket }
      if (!data.ticket) throw new Error('authentification refusée par Proxmox')
      return { ticket: data.ticket, csrf: data.CSRFPreventionToken, username: data.username || username }
    },

    nodes: () => cached('nodes', async () => {
      const list = await request('/nodes')
      return (list || []).map((n) => ({
        node: n.node,
        status: n.status,
        uptime: n.uptime,
        cpu: n.cpu,
        maxcpu: n.maxcpu,
        mem: n.mem,
        maxmem: n.maxmem,
        disk: n.disk,
        maxdisk: n.maxdisk,
        ssl_fingerprint: n.ssl_fingerprint,
        level: n.level,
      }))
    }),

    nodeStatus: (node) => cached(`status:${node}`, () => request(`/nodes/${encodeURIComponent(node)}/status`)),

    nodeRrd: (node, timeframe = 'hour') => cached(`rrd:${node}:${timeframe}`, () =>
      request(`/nodes/${encodeURIComponent(node)}/rrddata?timeframe=${timeframe}&cf=AVERAGE`)),

    resources: () => cached('resources', () => request('/cluster/resources?type=vm')),

    guestStatus: (node, type, vmid) => cached(`guest:${node}:${type}:${vmid}`, () =>
      request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/current`)),

    guestConfig: (node, type, vmid) => cached(`config:${node}:${type}:${vmid}`, () =>
      request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`)),

    guestRrd: (node, type, vmid, timeframe = 'hour') => cached(`guestrrd:${node}:${type}:${vmid}:${timeframe}`, () =>
      request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/rrddata?timeframe=${timeframe}&cf=AVERAGE`)),

    storages: (node) => cached(`storage:${node}`, () =>
      request(`/nodes/${encodeURIComponent(node)}/storage`)),

    tasks: (node, limit = 20) => request(`/nodes/${encodeURIComponent(node)}/tasks?limit=${limit}&start=0`),

    storageContent: (node, storage, content = 'vztmpl') => request(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=${content}`),

    createLxc: async (node, params) => {
      cache.clear()
      return request(`/nodes/${encodeURIComponent(node)}/lxc`, { method: 'POST', body: params })
    },

    nextVmid: async () => {
      const resources = (await request('/cluster/resources?type=vm')) || []
      const used = resources.map((r) => Number(r.vmid) || 0)
      return Math.max(100, ...used) + 1
    },

    // Modifie quelques options d'un invité (onboot, description, startup…).
    guestSetConfig: async (node, type, vmid, values) => {
      if (!['lxc', 'qemu'].includes(type)) throw new Error(`type inconnu : ${type}`)
      if (!/^\d{1,9}$/.test(String(vmid))) throw new Error('vmid invalide')
      const body = {}
      for (const [key, value] of Object.entries(values || {})) {
        if (!/^[a-z0-9_-]{1,32}$/.test(key)) throw new Error(`option invalide : ${key}`)
        body[key] = String(value)
      }
      if (!Object.keys(body).length) throw new Error('aucune option à modifier')
      cache.clear()
      return request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`, { method: 'PUT', body })
    },

    guestAction: async (node, type, vmid, action) => {
      const allowed = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume']
      if (!allowed.includes(action)) throw new Error(`action inconnue : ${action}`)
      if (!['lxc', 'qemu'].includes(type)) throw new Error(`type inconnu : ${type}`)
      if (!/^\d{1,9}$/.test(String(vmid))) throw new Error('vmid invalide')
      cache.clear()
      return request(`/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`, { method: 'POST', body: {} })
    },

    // --- instantanés -----------------------------------------------------

    snapshots: async (node, type, vmid) => {
      const guest = checkGuest(type, vmid)
      return request(`/nodes/${checkNode(node)}/${guest}/snapshot`)
    },

    snapshotCreate: async (node, type, vmid, { snapname, description = '' }) => {
      const guest = checkGuest(type, vmid)
      if (!SNAP_RE.test(String(snapname || ''))) throw new Error('nom d\'instantané invalide (a-z, 0-9, -, _)')
      if (String(snapname).toLowerCase() === 'current') throw new Error('nom réservé : current')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/${guest}/snapshot`, {
        method: 'POST',
        body: { snapname: String(snapname), description: String(description).slice(0, 500) },
      })
    },

    snapshotDelete: async (node, type, vmid, snapname) => {
      const guest = checkGuest(type, vmid)
      if (!SNAP_RE.test(String(snapname || ''))) throw new Error('instantané invalide')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/${guest}/snapshot/${encodeURIComponent(snapname)}`, { method: 'DELETE' })
    },

    snapshotRollback: async (node, type, vmid, snapname) => {
      const guest = checkGuest(type, vmid)
      if (!SNAP_RE.test(String(snapname || ''))) throw new Error('instantané invalide')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/${guest}/snapshot/${encodeURIComponent(snapname)}/rollback`, {
        method: 'POST',
        body: {},
      })
    },

    // --- clonage, disque, sauvegarde -------------------------------------

    cloneGuest: async (node, type, vmid, params = {}) => {
      const guest = checkGuest(type, vmid)
      const newid = String(params.vmid ?? '')
      if (!GUEST_RE.test(newid)) throw new Error('nouveau vmid invalide')
      const body = { newid }
      const hostname = String(params.hostname || '').trim()
      if (hostname) body[type === 'lxc' ? 'hostname' : 'name'] = hostname
      if (params.storage) body.storage = String(params.storage)
      if (params.target) body.target = String(params.target)
      body.full = params.full ? 1 : 0
      if (params.description) body.description = String(params.description).slice(0, 500)
      cache.clear()
      return request(`/nodes/${checkNode(node)}/${guest}/clone`, { method: 'POST', body })
    },

    resizeDisk: async (node, type, vmid, { disk = 'rootfs', size }) => {
      const guest = checkGuest(type, vmid)
      if (!DISK_RE.test(String(disk))) throw new Error('disque invalide')
      if (!SIZE_RE.test(String(size || ''))) throw new Error('taille invalide (ex. +2G, 16G)')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/${guest}/resize`, {
        method: 'PUT',
        body: { disk: String(disk), size: String(size) },
      })
    },

    vzdump: async (node, params = {}) => {
      const vmid = String(params.vmid ?? '')
      if (!GUEST_RE.test(vmid)) throw new Error('vmid invalide')
      if (!params.storage) throw new Error('stockage de sauvegarde manquant')
      const mode = ['snapshot', 'suspend', 'stop'].includes(params.mode) ? params.mode : 'snapshot'
      const compress = ['0', 'gzip', 'lzo', 'zstd'].includes(String(params.compress)) ? String(params.compress) : 'zstd'
      const body = { vmid, storage: String(params.storage), mode, compress, remove: 0 }
      if (params.notes) body.notes = String(params.notes).slice(0, 500)
      cache.clear()
      return request(`/nodes/${checkNode(node)}/vzdump`, { method: 'POST', body, timeout: 15000 })
    },

    backups: async (node) => {
      const storages = (await request(`/nodes/${checkNode(node)}/storage`)) || []
      const lists = await Promise.all(storages
        .filter((st) => String(st.content || '').includes('backup'))
        .map((st) => request(`/nodes/${checkNode(node)}/storage/${encodeURIComponent(st.storage)}/content?content=backup`)
          .then((items) => (items || []).map((item) => ({ ...item, storage: st.storage })))
          .catch(() => [])))
      return lists.flat().sort((a, b) => (b.ctime || 0) - (a.ctime || 0))
    },

    deleteVolume: async (node, storage, volid) => {
      if (!/^[a-zA-Z0-9._-]{1,32}$/.test(String(storage || ''))) throw new Error('stockage invalide')
      if (!/^[a-zA-Z0-9._-]+:[a-zA-Z0-9._\/-]+$/.test(String(volid || ''))) throw new Error('volume invalide')
      cache.clear()
      return request(
        `/nodes/${checkNode(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
        { method: 'DELETE' },
      )
    },

    // --- tâches, journal, nœud, modèles ----------------------------------

    taskStatus: async (node, upid) => {
      if (!/^UPID:[A-Za-z0-9:._-]{10,200}$/.test(String(upid || ''))) throw new Error('identifiant de tâche invalide')
      return request(`/nodes/${checkNode(node)}/tasks/${encodeURIComponent(upid)}/status`)
    },

    taskLog: async (node, upid, { start = 0, limit = 400 } = {}) => {
      if (!/^UPID:[A-Za-z0-9:._-]{10,200}$/.test(String(upid || ''))) throw new Error('identifiant de tâche invalide')
      const from = Math.max(0, Number(start) || 0)
      const count = Math.min(Math.max(Number(limit) || 400, 1), 2000)
      return request(`/nodes/${checkNode(node)}/tasks/${encodeURIComponent(upid)}/log?start=${from}&limit=${count}`)
    },

    taskStop: async (node, upid) => {
      if (!/^UPID:[A-Za-z0-9:._-]{10,200}$/.test(String(upid || ''))) throw new Error('identifiant de tâche invalide')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/tasks/${encodeURIComponent(upid)}`, { method: 'DELETE' })
    },

    syslog: async (node, limit = 200) => {
      const count = Math.min(Math.max(Number(limit) || 200, 1), 1000)
      return request(`/nodes/${checkNode(node)}/syslog?limit=${count}`)
    },

    nodePower: async (node, action) => {
      if (!['reboot', 'shutdown'].includes(action)) throw new Error(`action inconnue : ${action}`)
      cache.clear()
      return request(`/nodes/${checkNode(node)}/status`, { method: 'POST', body: { command: action } })
    },

    aplinfo: async (node) => request(`/nodes/${checkNode(node)}/aplinfo`),

    templateDownload: async (node, { storage, template }) => {
      if (!/^[a-zA-Z0-9._-]{1,32}$/.test(String(storage || ''))) throw new Error('stockage invalide')
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{1,120}$/.test(String(template || ''))) throw new Error('modèle invalide')
      cache.clear()
      return request(`/nodes/${checkNode(node)}/aplinfo`, { method: 'POST', body: { storage, template } })
    },

    async overview() {
      const [nodes, resources] = await Promise.all([this.nodes(), this.resources()])
      const guests = (resources || [])
        .filter((r) => r.type === 'lxc' || r.type === 'qemu')
        .map((g) => ({
          vmid: g.vmid,
          name: g.name || `#${g.vmid}`,
          node: g.node,
          type: g.type,
          status: g.status,
          template: Boolean(g.template),
          cpu: g.cpu ?? 0,
          maxcpu: g.maxcpu ?? 1,
          mem: g.mem ?? 0,
          maxmem: g.maxmem ?? 0,
          disk: g.disk ?? 0,
          maxdisk: g.maxdisk ?? 0,
          uptime: g.uptime ?? 0,
          tags: g.tags || '',
          pool: g.pool || '',
        }))
        .sort((a, b) => a.vmid - b.vmid)
      return {
        nodes,
        guests,
        counts: {
          lxc: guests.filter((g) => g.type === 'lxc').length,
          qemu: guests.filter((g) => g.type === 'qemu').length,
          running: guests.filter((g) => g.status === 'running').length,
          stopped: guests.filter((g) => g.status !== 'running').length,
        },
      }
    },
  }
}

module.exports = { createClient }
