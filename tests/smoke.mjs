import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startFakePve } from './fake-pve.mjs'

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 8200 + Math.floor(Math.random() * 600)
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'test-password-123'
const SESSION = `t${Date.now() % 1_000_000}`

const tmp = mkdtempSync(path.join(os.tmpdir(), 'serverdeck-'))
const configPath = path.join(tmp, 'config.json')
const keyPath = path.join(tmp, 'id_ed25519')

let server
let fake
let passed = 0
let failed = 0
let env

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('le serveur ne répond pas')
}

function openWs(cookie, params) {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { Cookie: cookie } : {}
    const query = new URLSearchParams({ cols: '100', rows: '30', ...params })
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`, { headers })
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', reject)
  })
}

async function terminalRoundTrip(cookie, params, expectations, input = 'echo HELLO_SD; echo COLS=$(tput cols)\n') {
  const ws = await openWs(cookie, params)
  let out = ''
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pas de sortie (${JSON.stringify(out.slice(-200))})`)), 15000)
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.t === 'error') {
        clearTimeout(timer)
        return reject(new Error(`erreur serveur : ${msg.m}`))
      }
      if (msg.t !== 'd') return
      out += msg.d
      if (out.includes(expectations)) {
        clearTimeout(timer)
        resolve()
      }
    })
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ t: 'r', c: 100, r: 30 }))
  await sleep(1200)
  ws.send(JSON.stringify({ t: 'i', d: input }))
  await done
  ws.close()
  return out
}

async function main() {
  // faux « ssh » : le serveur l'appelle pour les shells de conteneurs
  const binDir = path.join(tmp, 'bin')
  mkdirSync(binDir)
  const sshStub = path.join(binDir, 'ssh')
  writeFileSync(sshStub, '#!/bin/sh\necho "CT_SHELL_OK cols=$(tput cols 2>/dev/null)"\nsleep 0.3\n')
  chmodSync(sshStub, 0o755)

  // clé SSH factice (ensureKey la considère existante)
  writeFileSync(keyPath, 'dummy-private-key\n', { mode: 0o600 })
  writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY serverdeck\n')

  fake = await startFakePve()

  env = {
    ...process.env,
    SERVERDECK_CONFIG: configPath,
    SERVERDECK_MAX_FILE_BYTES: '4096',
    PATH: `${binDir}:${process.env.PATH}`,
  }

  await run(process.execPath, ['src/setup.js', '--password', PASSWORD, '--no-totp', '--port', String(PORT), '--force'], { cwd: ROOT, env })
  await run(process.execPath, [
    'src/setup-pve.js',
    '--host', '127.0.0.1',
    '--port', String(fake.port),
    '--scheme', 'http',
    '--token-id', fake.tokenId,
    '--token-secret', fake.tokenSecret,
    '--key', keyPath,
    '--ssh-user', 'root',
    '--ssh-port', '22',
    '--no-verify-tls',
  ], { cwd: ROOT, env })

  server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: 'ignore' })
  await waitForServer()

  console.log('smoke test')

  await check('santé publique', async () => {
    const res = await fetch(`${BASE}/api/health`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
  })

  await check('page protégée sans cookie', async () => {
    const res = await fetch(`${BASE}/`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/login')
  })

  await check('API protégée sans cookie', async () => {
    assert.equal((await fetch(`${BASE}/api/me`)).status, 401)
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 401)
    assert.equal((await fetch(`${BASE}/api/pve/overview`)).status, 401)
  })

  await check('WebSocket refusé sans cookie', async () => {
    await assert.rejects(openWs(null, { session: SESSION }), /401/)
  })

  await check('mauvais mot de passe refusé', async () => {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'mode=local&password=mauvais&code=',
      redirect: 'manual',
    })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/login?e=1')
  })

  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `mode=local&password=${PASSWORD}&code=`,
    redirect: 'manual',
  })
  const setCookie = login.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]

  await check('connexion : cookie signé HttpOnly SameSite', async () => {
    assert.equal(login.status, 302)
    assert.ok(cookie.startsWith('sd='))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Strict/i)
  })

  await check('auth-mode annonce Proxmox', async () => {
    const info = await (await fetch(`${BASE}/api/auth-mode`)).json()
    assert.equal(info.mode, 'proxmox')
    assert.equal(info.allowLocal, true)
  })

  await check('connexion Proxmox : identifiants acceptés', async () => {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'root@pam', password: 'secret' }).toString(),
      redirect: 'manual',
    })
    assert.equal(res.status, 302)
    const sessionCookie = (res.headers.get('set-cookie') || '').split(';')[0]
    const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: sessionCookie } })).json()
    assert.equal(me.user, 'root@pam')
    assert.equal(me.proxmox, true)
  })

  await check('connexion Proxmox : mauvais mot de passe refusé', async () => {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'root@pam', password: 'faux' }).toString(),
      redirect: 'manual',
    })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), '/login?e=1')
  })

  await check('connexion Proxmox : 2FA demandée puis validée', async () => {
    const first = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin@pve', password: 'secret' }).toString(),
      redirect: 'manual',
    })
    assert.equal(first.status, 303)
    const location = first.headers.get('location') || ''
    assert.match(location, /^\/login\?tfa=/)
    const nonce = new URL(`http://x${location}`).searchParams.get('tfa')

    const wrong = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tfa: nonce, code: '000000' }).toString(),
      redirect: 'manual',
    })
    assert.equal(wrong.status, 303)
    assert.equal(wrong.headers.get('location'), '/login?e=1')

    const again = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin@pve', password: 'secret' }).toString(),
      redirect: 'manual',
    })
    const nonce2 = new URL(`http://x${again.headers.get('location')}`).searchParams.get('tfa')
    const second = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tfa: nonce2, code: '123456' }).toString(),
      redirect: 'manual',
    })
    assert.equal(second.status, 302)
    const sessionCookie = (second.headers.get('set-cookie') || '').split(';')[0]
    const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: sessionCookie } })).json()
    assert.equal(me.user, 'admin@pve')
  })

  await check('application servie avec cookie', async () => {
    const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } })
    const html = await res.text()
    assert.equal(res.status, 200)
    assert.ok(html.includes('id="term"'))
    assert.ok(html.includes('id="view-nodes"'))
    assert.ok(html.includes('/pve.js'))
  })

  await check('cookie falsifié refusé', async () => {
    const forged = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))
    assert.equal((await fetch(`${BASE}/api/me`, { headers: { Cookie: forged } })).status, 401)
  })

  await check('assets versionnés comme le paquet', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    for (const asset of ['style.css', 'app.js', 'pve.js', 'files.js', 'i18n.js']) {
      const pattern = new RegExp(`${asset.replace('.', '\\.')}\\?v=${pkg.version.replace(/\./g, '\\.')}`)
      assert.match(html, pattern, `${asset} doit être servi en ?v=${pkg.version}`)
    }
  })

  await check('xterm.js servi', async () => {
    const res = await fetch(`${BASE}/vendor/xterm/lib/xterm.js`)
    assert.equal(res.status, 200)
    assert.ok((await res.text()).length > 1000)
  })

  await check('statistiques système', async () => {
    const sys = await (await fetch(`${BASE}/api/system`, { headers: { Cookie: cookie } })).json()
    assert.ok(sys.mem.total > 0)
    assert.ok(sys.cpus > 0)
    assert.equal(sys.hostname, os.hostname())
  })

  await check('terminal local : echo + resize 100 colonnes', () =>
    terminalRoundTrip(cookie, { session: SESSION }, 'COLS=100'))

  await check('session créée puis listée', async () => {
    const res = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${SESSION}x` }),
    })
    assert.equal(res.status, 200)
    const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { Cookie: cookie } })).json()
    assert.ok(sessions.some((s) => s.name === `${SESSION}x`))
  })

  await check('nom de session invalide refusé', async () => {
    const res = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../evil' }),
    })
    assert.equal(res.status, 400)
  })

  await check('session tuée', async () => {
    const res = await fetch(`${BASE}/api/sessions/${SESSION}x`, { method: 'DELETE', headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
  })

  // --- Proxmox ------------------------------------------------------------

  await check('Proxmox : vue d\'ensemble', async () => {
    const res = await fetch(`${BASE}/api/pve/overview`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.nodes.length, 1)
    assert.equal(data.nodes[0].node, 'pve1')
    assert.equal(data.guests.length, 3)
    assert.deepEqual(data.counts, { lxc: 2, qemu: 1, running: 2, stopped: 1 })
  })

  await check('Proxmox : vérification de connexion', async () => {
    const data = await (await fetch(`${BASE}/api/pve/check`, { headers: { Cookie: cookie } })).json()
    assert.equal(data.ok, true)
    assert.equal(data.version, '8.2.4')
  })

  await check('Proxmox : détail d\'un conteneur', async () => {
    const data = await (await fetch(`${BASE}/api/pve/guests/pve1/lxc/101`, { headers: { Cookie: cookie } })).json()
    assert.equal(data.status.status, 'running')
    assert.equal(data.config.hostname, 'web')
    assert.equal(data.rrd.length, 12)
  })

  await check('Proxmox : nœud, stockage et tâches', async () => {
    const node = await (await fetch(`${BASE}/api/pve/nodes/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(node.status.kversion.startsWith('Linux'), true)
    const storages = await (await fetch(`${BASE}/api/pve/storages/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(storages.storages.length, 2)
    const tasks = await (await fetch(`${BASE}/api/pve/tasks/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(tasks.tasks.length, 2)
  })

  await check('Proxmox : action start transmise', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/102/start`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(fake.actions.at(-1), { node: 'pve1', type: 'lxc', vmid: 102, action: 'start' })
  })

  await check('Proxmox : action inconnue refusée', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/explode`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    assert.equal(res.status, 502)
  })

  await check('Proxmox : vmid invalide refusé', async () => {
    const res = await fetch(`${BASE}/api/pve/guests/pve1/lxc/abc`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 400)
  })

  await check('Proxmox : infos d\'appairage', async () => {
    const info = await (await fetch(`${BASE}/api/pve/setup`, { headers: { Cookie: cookie } })).json()
    assert.equal(info.configured, true)
    assert.match(info.sshPublicKey, /^ssh-ed25519 /)
    assert.match(info.authorizedKeys, /command="\/usr\/local\/sbin\/serverdeck-shell"/)
  })

  await check('shell de conteneur via SSH', async () => {
    const out = await terminalRoundTrip(cookie, { kind: 'ct', vmid: '101' }, 'CT_SHELL_OK', '')
    assert.match(out, /cols=100/)
  })

  await check('shell de conteneur : vmid invalide refusé', async () => {
    const ws = await openWs(cookie, { kind: 'ct', vmid: '../x' })
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pas de réponse')), 5000)
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.t === 'error') {
          clearTimeout(timer)
          resolve(msg.m)
        }
      })
    })
    ws.close()
    assert.match(message, /invalide/)
  })

  await check('hôte Proxmox enregistrable depuis l\'interface', async () => {
    const res = await fetch(`${BASE}/api/pve/config`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: fake.port, scheme: 'http' }),
    })
    assert.equal(res.status, 200)
    const info = await (await fetch(`${BASE}/api/auth-mode`)).json()
    assert.equal(info.mode, 'proxmox')
    assert.equal(info.host, '127.0.0.1')
  })

  await check('hôte invalide refusé', async () => {
    const res = await fetch(`${BASE}/api/pve/config`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'http://pas-un-hote' }),
    })
    assert.equal(res.status, 400)
  })

  await check('Proxmox : instantanés (liste, création, retour, suppression)', async () => {
    const list = await (await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/snapshots`, { headers: { Cookie: cookie } })).json()
    assert.equal(list.snapshots.length, 1)
    assert.equal(list.snapshots[0].name, 'before-upgrade')

    const create = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/snapshots`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapname: 'avant-apt', description: 'test' }),
    })
    assert.equal(create.status, 200)
    assert.deepEqual(fake.actions.at(-1), {
      node: 'pve1', type: 'lxc', vmid: 101, action: 'snapshot', snapname: 'avant-apt',
    })

    const invalid = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/snapshots`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapname: 'a b' }),
    })
    assert.equal(invalid.status, 400)

    const rollback = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/snapshots/before-upgrade/rollback`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    assert.equal(rollback.status, 200)
    assert.equal(fake.actions.at(-1).action, 'snapshot-rollback')

    const del = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/snapshots/avant-apt`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assert.equal(del.status, 200)
    assert.equal(fake.actions.at(-1).action, 'snapshot-delete')
  })

  await check('Proxmox : clonage et redimensionnement', async () => {
    const clone = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/clone`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vmid: 150, hostname: 'web-copie', full: true }),
    })
    assert.equal(clone.status, 200)
    assert.equal((await clone.json()).vmid, 150)
    assert.deepEqual(fake.actions.at(-1), {
      node: 'pve1', type: 'lxc', vmid: 101, action: 'clone',
      body: { newid: '150', hostname: 'web-copie', full: '1' },
    })

    const resize = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/resize`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disk: 'rootfs', size: '+2G' }),
    })
    assert.equal(resize.status, 200)
    assert.equal(fake.actions.at(-1).action, 'resize')

    const badSize = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/resize`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disk: 'rootfs', size: 'beaucoup' }),
    })
    assert.equal(badSize.status, 400)
  })

  await check('Proxmox : sauvegardes (liste, lancement, suppression)', async () => {
    const list = await (await fetch(`${BASE}/api/pve/backups/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(list.backups.length, 2)
    assert.equal(list.backups[0].storage, 'local')

    const filtered = await (await fetch(`${BASE}/api/pve/backups/pve1?vmid=102`, { headers: { Cookie: cookie } })).json()
    assert.equal(filtered.backups.length, 1)
    assert.equal(filtered.backups[0].vmid, 102)

    const run = await fetch(`${BASE}/api/pve/guests/pve1/lxc/101/backup`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage: 'local', mode: 'snapshot', compress: 'zstd' }),
    })
    assert.equal(run.status, 200)
    assert.equal(fake.actions.at(-1).action, 'vzdump')
    assert.equal(fake.actions.at(-1).body.vmid, '101')

    const volid = encodeURIComponent('local:backup/vzdump-lxc-101-2026_11_20-03_00_01.tar.zst')
    const del = await fetch(`${BASE}/api/pve/backups/pve1/local/${volid}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assert.equal(del.status, 200)
    assert.deepEqual(fake.actions.at(-1), {
      node: 'pve1', action: 'delete-volume', storage: 'local',
      volid: 'local:backup/vzdump-lxc-101-2026_11_20-03_00_01.tar.zst',
    })
  })

  await check('Proxmox : tâches (statut, journal, arrêt)', async () => {
    const upid = encodeURIComponent('UPID:pve1:0001:task')
    const detail = await (await fetch(`${BASE}/api/pve/tasks/pve1/${upid}`, { headers: { Cookie: cookie } })).json()
    assert.equal(detail.status.status, 'stopped')
    assert.equal(detail.log.length, 3)

    const stop = await fetch(`${BASE}/api/pve/tasks/pve1/${encodeURIComponent('UPID:pve1:0005:running')}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assert.equal(stop.status, 200)
    assert.equal(fake.actions.at(-1).action, 'task-stop')

    const bad = await fetch(`${BASE}/api/pve/tasks/pve1/pas-un-upid`, { headers: { Cookie: cookie } })
    assert.equal(bad.status, 400)
  })

  await check('Proxmox : journal du nœud et alimentation', async () => {
    const log = await (await fetch(`${BASE}/api/pve/syslog/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(log.lines.length, 2)
    assert.match(log.lines[0].t, /pvedaemon/)

    const reboot = await fetch(`${BASE}/api/pve/nodes/pve1/power`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reboot' }),
    })
    assert.equal(reboot.status, 200)
    assert.deepEqual(fake.actions.at(-1), { node: 'pve1', action: 'node-power', command: 'reboot' })

    const bad = await fetch(`${BASE}/api/pve/nodes/pve1/power`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    })
    assert.equal(bad.status, 400)
  })

  await check('Proxmox : modèles disponibles et téléchargement', async () => {
    const info = await (await fetch(`${BASE}/api/pve/templates/available/pve1`, { headers: { Cookie: cookie } })).json()
    assert.equal(info.appliances.length, 2)
    assert.equal(info.storages[0].storage, 'local')

    const download = await fetch(`${BASE}/api/pve/templates/pve1/download`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage: 'local', template: 'debian-12-standard_12.12-1_amd64.tar.zst' }),
    })
    assert.equal(download.status, 200)
    assert.equal(fake.actions.at(-1).action, 'template-download')
  })

  // --- Fichiers -----------------------------------------------------------

  const fileName = 'notes test.txt'
  const fileUrl = `${BASE}/api/files/${encodeURIComponent(fileName)}`
  const fileBody = Buffer.from('bonjour serverdeck')

  await check('fichiers : accès refusé sans cookie', async () => {
    assert.equal((await fetch(`${BASE}/api/files`)).status, 401)
    assert.equal((await fetch(fileUrl, { method: 'PUT', body: fileBody })).status, 401)
    assert.equal((await fetch(fileUrl)).status, 401)
    assert.equal((await fetch(fileUrl, { method: 'DELETE' })).status, 401)
  })

  await check('fichiers : envoi puis liste', async () => {
    const res = await fetch(fileUrl, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: fileBody,
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.file.name, fileName)
    assert.equal(data.file.size, fileBody.length)

    const list = await (await fetch(`${BASE}/api/files`, { headers: { Cookie: cookie } })).json()
    assert.deepEqual(list.files.map((file) => file.name), [fileName])
    assert.equal(list.total, fileBody.length)
    assert.equal(list.max, 4096)
    assert.ok(list.free > 0)
  })

  await check('fichiers : téléchargement authentifié', async () => {
    const res = await fetch(fileUrl, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition') || '', /^attachment;/)
    assert.equal(await res.text(), fileBody.toString())
  })

  await check('fichiers : envoi trop gros refusé', async () => {
    const res = await fetch(`${BASE}/api/files/gros.bin`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(8192, 1),
    })
    assert.equal(res.status, 413)
    const list = await (await fetch(`${BASE}/api/files`, { headers: { Cookie: cookie } })).json()
    assert.ok(!list.files.some((file) => file.name === 'gros.bin'))
  })

  await check('fichiers : type de contenu refusé', async () => {
    const res = await fetch(`${BASE}/api/files/x.json`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{"a":1}',
    })
    assert.equal(res.status, 415)
    const list = await (await fetch(`${BASE}/api/files`, { headers: { Cookie: cookie } })).json()
    assert.ok(!list.files.some((file) => file.name === 'x.json'))
  })

  await check('fichiers : nom de chemin refusé', async () => {
    for (const bad of ['..%2Fevil', 'x%2F..%2Fy', '.cache', 'a%5Cb']) {
      const res = await fetch(`${BASE}/api/files/${bad}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('x'),
      })
      assert.equal(res.status, 400, bad)
    }
  })

  await check('fichiers : lien signé utilisable sans session', async () => {
    const link = await (await fetch(`${fileUrl}/link`, { headers: { Cookie: cookie } })).json()
    assert.match(link.url, /\/d\/notes%20test\.txt\?t=/)
    assert.ok(link.exp > Date.now())

    const direct = await fetch(`${BASE}/d/${encodeURIComponent(fileName)}?t=invalide`)
    assert.equal(direct.status, 403)

    const res = await fetch(link.url)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), fileBody.toString())

    const tampered = link.url.replace(/\?t=/, '?t=x')
    assert.equal((await fetch(tampered)).status, 403)
  })

  await check('fichiers : renommage', async () => {
    const res = await fetch(`${fileUrl}/rename`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'notes-2.txt' }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).file.name, 'notes-2.txt')
    const list = await (await fetch(`${BASE}/api/files`, { headers: { Cookie: cookie } })).json()
    assert.deepEqual(list.files.map((file) => file.name), ['notes-2.txt'])
    assert.equal((await fetch(fileUrl, { headers: { Cookie: cookie } })).status, 404)
  })

  await check('fichiers : suppression', async () => {
    const target = `${BASE}/api/files/${encodeURIComponent('notes-2.txt')}`
    const res = await fetch(target, { method: 'DELETE', headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const list = await (await fetch(`${BASE}/api/files`, { headers: { Cookie: cookie } })).json()
    assert.deepEqual(list.files, [])
    assert.equal((await fetch(target, { method: 'DELETE', headers: { Cookie: cookie } })).status, 404)
  })

  await check('sessions web : liste et révocation', async () => {
    const second = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `mode=local&password=${PASSWORD}&code=`,
      redirect: 'manual',
    })
    const secondCookie = (second.headers.get('set-cookie') || '').split(';')[0]

    const { sessions } = await (await fetch(`${BASE}/api/auth-sessions`, { headers: { Cookie: cookie } })).json()
    assert.ok(sessions.length >= 2, `${sessions.length} session(s)`)
    assert.ok(sessions.some((s) => s.current))

    const other = sessions.find((s) => !s.current)
    const revoke = await fetch(`${BASE}/api/auth-sessions/${encodeURIComponent(other.id)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    assert.equal(revoke.status, 200)

    const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: secondCookie } })
    assert.equal(me.status, 401)
  })

  await check('déconnexion efface le cookie', async () => {
    const res = await fetch(`${BASE}/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.match(res.headers.get('set-cookie') || '', /sd=;/)
  })

  await check('blocage après 6 tentatives', async () => {
    let last = 0
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=faux&code=',
        redirect: 'manual',
      })
      last = res.status
    }
    assert.equal(last, 429)
  })

  console.log(`\n${passed} vérifications · ${failed} échec(s)`)
}

try {
  await main()
} finally {
  server?.kill()
  await fake?.close()
  await run('tmux', ['-L', 'serverdeck', 'kill-session', '-t', `=sd_${SESSION}`], {}).catch(() => {})
  await run('tmux', ['-L', 'serverdeck', 'kill-session', '-t', `=sd_${SESSION}x`], {}).catch(() => {})
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
}
process.exit(failed === 0 ? 0 : 1)
