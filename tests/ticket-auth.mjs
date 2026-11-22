import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startFakePve } from './fake-pve.mjs'

const require = createRequire(import.meta.url)
const auth = require('../src/auth.js')

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 8800 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'LocalPass123'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'serverdeck-ticket-'))
const configPath = path.join(tmp, 'config.json')

let server
let fake
let passed = 0
let failed = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${label}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${label}\n       ${err.message}`)
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('le serveur ne répond pas')
}

async function login(body) {
  return fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  })
}

async function main() {
  fake = await startFakePve()

  // Configuration minimale : l'hôte Proxmox, sans jeton d'API.
  writeFileSync(configPath, JSON.stringify({
    port: PORT,
    bind: '127.0.0.1',
    passwordHash: auth.hashPassword(PASSWORD),
    totpSecret: null,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    sessionHours: 1,
    proxmox: { host: '127.0.0.1', port: fake.port, scheme: 'http' },
  }, null, 2))

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, SERVERDECK_CONFIG: configPath },
    stdio: 'ignore',
  })
  await waitForServer()

  console.log('connexion par identifiants Proxmox, sans jeton d\'API')

  await check('auth-mode annonce Proxmox', async () => {
    const info = await (await fetch(`${BASE}/api/auth-mode`)).json()
    assert.equal(info.mode, 'proxmox')
    assert.equal(info.host, '127.0.0.1')
  })

  await check('sans session, l\'API Proxmox est refusée', async () => {
    const res = await fetch(`${BASE}/api/pve/overview`)
    assert.ok([401, 403].includes(res.status), `statut ${res.status}`)
  })

  await check('mauvais mot de passe refusé', async () => {
    const res = await login({ username: 'root@pam', password: 'faux' })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/login?e=1')
  })

  const good = await login({ username: 'root@pam', password: 'secret' })
  const cookie = (good.headers.get('set-cookie') || '').split(';')[0]

  await check('connexion acceptée par Proxmox', async () => {
    assert.equal(good.status, 302)
    assert.ok(cookie.startsWith('sd='))
  })

  await check('l\'utilisateur Proxmox est dans la session', async () => {
    const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json()
    assert.equal(me.user, 'root@pam')
    assert.equal(me.proxmox, true)
  })

  await check('les ressources passent par le ticket de l\'utilisateur', async () => {
    const res = await fetch(`${BASE}/api/pve/overview`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.nodes.length, 1)
    assert.equal(data.guests.length, 3)
  })

  await check('détail et actions avec le ticket', async () => {
    const detail = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101`, { headers: { Cookie: cookie } })
    assert.equal(detail.status, 200)
    const action = await fetch(`${BASE}/api/pve/guests/pve1/lxc/102/start`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    assert.equal(action.status, 200)
    assert.deepEqual(fake.actions.at(-1), { node: 'pve1', type: 'lxc', vmid: 102, action: 'start' })
  })

  await check('option « démarrer au boot » modifiable', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboot: 1 }),
    })
    assert.equal(res.status, 200)
    const last = fake.actions.at(-1)
    assert.equal(last.action, 'config')
    assert.deepEqual(last.body, { onboot: '1' })
  })

  await check('option non autorisée refusée', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inconnu: 'x' }),
    })
    assert.equal(res.status, 400)
  })

  await check('valeur invalide refusée', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cores: 'beaucoup' }),
    })
    assert.equal(res.status, 400)
  })

  await check('plage de courbe acceptée', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101?timeframe=week`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.rrd.length, 12)
  })

  await check('modèles et prochain vmid', async () => {
    const res = await fetch(`${BASE}/api/pve/templates/pve1`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.templates.length, 2)
    assert.match(data.templates[0].volid, /vztmpl/)
    assert.equal(data.nextVmid, 201)
  })

  await check('création de conteneur transmise à Proxmox', async () => {
    const res = await fetch(`${BASE}/api/pve/lxc`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node: 'pve1',
        vmid: '201',
        hostname: 'nouveau',
        ostemplate: 'local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst',
        cores: '2',
        memory: '1024',
        swap: '512',
        storage: 'local-lvm',
        disk: '4',
        bridge: 'vmbr0',
        ip: 'dhcp',
        gw: '',
        password: 'motdepasse',
        start: 1,
        onboot: 1,
      }),
    })
    assert.equal(res.status, 200)
    const last = fake.actions.at(-1)
    assert.equal(last.action, 'create')
    assert.equal(last.body.vmid, '201')
    assert.equal(last.body.rootfs, 'local-lvm:4')
    assert.equal(last.body.net0, 'name=eth0,bridge=vmbr0,ip=dhcp')
    assert.equal(last.body.start, '1')
    assert.equal(last.body.unprivileged, '1')
  })

  await check('création refusée si un champ est invalide', async () => {
    const res = await fetch(`${BASE}/api/pve/lxc`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: 'pve1', vmid: 'abc', hostname: 'x' }),
    })
    assert.equal(res.status, 400)
  })

  await check('après déconnexion, plus d\'accès Proxmox', async () => {
    await fetch(`${BASE}/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' })
    const res = await fetch(`${BASE}/api/pve/overview`, { headers: { Cookie: cookie } })
    assert.ok([401, 403].includes(res.status), `statut ${res.status}`)
  })

  console.log(`\n${passed} vérifications · ${failed} échec(s)`)
}

try {
  await main()
} finally {
  server?.kill()
  await fake?.close()
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
}
process.exit(failed === 0 ? 0 : 1)
