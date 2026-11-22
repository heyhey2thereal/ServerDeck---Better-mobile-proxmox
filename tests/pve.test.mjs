import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startFakePve } from './fake-pve.mjs'

const require = createRequire(import.meta.url)
const { createClient } = require('../src/proxmox.js')

let fake
let client

before(async () => {
  fake = await startFakePve()
  client = createClient({
    host: '127.0.0.1',
    port: fake.port,
    scheme: 'http',
    tokenId: fake.tokenId,
    tokenSecret: fake.tokenSecret,
  })
})

after(async () => { await fake.close() })

test('client nul sans hôte', () => {
  assert.equal(createClient(null), null)
  assert.equal(createClient({}), null)
  assert.equal(createClient({ tokenId: 'a', tokenSecret: 'b' }), null)
})

test('client sans jeton : connexion par identifiants possible', () => {
  const client = createClient({ host: 'pve.local' })
  assert.equal(client.host, 'pve.local')
  assert.equal(typeof client.login, 'function')
})

test('version et nœuds', async () => {
  const version = await client.version()
  assert.equal(version.version, '8.2.4')
  const nodes = await client.nodes()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].node, 'pve1')
  assert.equal(nodes[0].maxcpu, 8)
})

test('vue d\'ensemble : nœuds + invités + compteurs', async () => {
  const overview = await client.overview()
  assert.equal(overview.nodes.length, 1)
  assert.equal(overview.guests.length, 3)
  assert.deepEqual(overview.counts, { lxc: 2, qemu: 1, running: 2, stopped: 1 })
  assert.equal(overview.guests[0].vmid, 101)
  assert.equal(overview.guests[0].name, 'web')
})

test('statut et config d\'un conteneur', async () => {
  const status = await client.guestStatus('pve1', 'lxc', 101)
  assert.equal(status.status, 'running')
  assert.equal(status.cpus, 2)
  const config = await client.guestConfig('pve1', 'lxc', 101)
  assert.equal(config.hostname, 'web')
  assert.equal(config.cores, 2)
})

test('RRD, stockage et tâches', async () => {
  assert.equal((await client.nodeRrd('pve1')).length, 12)
  assert.equal((await client.guestRrd('pve1', 'lxc', 101)).length, 12)
  assert.equal((await client.storages('pve1')).length, 2)
  assert.equal((await client.tasks('pve1'))[0].type, 'vzdump')
})

test('action sur un invité : transmise à l\'API', async () => {
  const upid = await client.guestAction('pve1', 'lxc', 101, 'start')
  assert.match(upid, /start/)
  assert.deepEqual(fake.actions.at(-1), { node: 'pve1', type: 'lxc', vmid: 101, action: 'start' })
})

test('actions et identifiants invalides refusés côté client', async () => {
  await assert.rejects(client.guestAction('pve1', 'lxc', 101, 'rm -rf'), /action inconnue/)
  await assert.rejects(client.guestAction('pve1', 'lxc', '../1', 'start'), /vmid invalide/)
  await assert.rejects(client.guestAction('pve1', 'docker', 101, 'start'), /type inconnu/)
})

test('jeton invalide : erreur explicite', async () => {
  const bad = createClient({
    host: '127.0.0.1',
    port: fake.port,
    scheme: 'http',
    tokenId: 'test@pve!api',
    tokenSecret: 'mauvais',
  })
  await assert.rejects(bad.version(), /authentication failure/)
})

test('serveur injoignable : erreur de connexion', async () => {
  const offline = createClient({
    host: '127.0.0.1',
    port: 1,
    scheme: 'http',
    tokenId: 'a',
    tokenSecret: 'b',
  })
  await assert.rejects(offline.version(), /ECONNREFUSED|délai/)
})

test('instantanés : liste, création, retour arrière, suppression', async () => {
  const list = await client.snapshots('pve1', 'lxc', 101)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'before-upgrade')

  await client.snapshotCreate('pve1', 'lxc', 101, { snapname: 'avant-apt', description: 'test' })
  assert.deepEqual(fake.actions.at(-1), {
    node: 'pve1', type: 'lxc', vmid: 101, action: 'snapshot', snapname: 'avant-apt',
  })
  assert.ok((await client.snapshots('pve1', 'lxc', 101)).some((snap) => snap.name === 'avant-apt'))

  await client.snapshotRollback('pve1', 'lxc', 101, 'before-upgrade')
  assert.equal(fake.actions.at(-1).action, 'snapshot-rollback')

  await client.snapshotDelete('pve1', 'lxc', 101, 'avant-apt')
  assert.equal(fake.actions.at(-1).action, 'snapshot-delete')
  assert.ok(!(await client.snapshots('pve1', 'lxc', 101)).some((snap) => snap.name === 'avant-apt'))

  await assert.rejects(client.snapshotCreate('pve1', 'lxc', 101, { snapname: 'a b' }), /invalide/)
  await assert.rejects(client.snapshotCreate('pve1', 'lxc', 101, { snapname: 'current' }), /réservé/)
  await assert.rejects(client.snapshotDelete('pve1', 'lxc', 101, '../x'), /invalide/)
})

test('clonage : transmis avec le bon champ hostname/name', async () => {
  await client.cloneGuest('pve1', 'lxc', 101, { vmid: 150, hostname: 'web-copie', full: true })
  assert.deepEqual(fake.actions.at(-1), {
    node: 'pve1', type: 'lxc', vmid: 101, action: 'clone',
    body: { newid: '150', hostname: 'web-copie', full: '1' },
  })
  await client.cloneGuest('pve1', 'qemu', 200, { vmid: 250, hostname: 'win-copie' })
  assert.equal(fake.actions.at(-1).body.name, 'win-copie')
  await assert.rejects(client.cloneGuest('pve1', 'lxc', 101, { vmid: 'abc' }), /vmid invalide/)
})

test('redimensionnement du disque', async () => {
  await client.resizeDisk('pve1', 'lxc', 101, { disk: 'rootfs', size: '+2G' })
  assert.deepEqual(fake.actions.at(-1), {
    node: 'pve1', type: 'lxc', vmid: 101, action: 'resize', body: { disk: 'rootfs', size: '+2G' },
  })
  await assert.rejects(client.resizeDisk('pve1', 'lxc', 101, { size: 'gros' }), /taille invalide/)
  await assert.rejects(client.resizeDisk('pve1', 'lxc', 101, { disk: '../x', size: '+1G' }), /disque invalide/)
})

test('sauvegardes : liste, lancement, suppression', async () => {
  const list = await client.backups('pve1')
  assert.equal(list.length, 2)
  assert.equal(list[0].storage, 'local')
  assert.ok(list[0].ctime >= list[1].ctime)

  await client.vzdump('pve1', { vmid: 101, storage: 'local', mode: 'snapshot', compress: 'zstd' })
  assert.deepEqual(fake.actions.at(-1).body, {
    vmid: '101', storage: 'local', mode: 'snapshot', compress: 'zstd', remove: '0',
  })
  await assert.rejects(client.vzdump('pve1', { vmid: 101 }), /stockage/)
  await assert.rejects(client.vzdump('pve1', { vmid: 'x', storage: 'local' }), /vmid invalide/)

  await client.deleteVolume('pve1', 'local', 'local:backup/vzdump-lxc-101.tar.zst')
  assert.deepEqual(fake.actions.at(-1), {
    node: 'pve1', action: 'delete-volume', storage: 'local', volid: 'local:backup/vzdump-lxc-101.tar.zst',
  })
  await assert.rejects(client.deleteVolume('pve1', 'local', 'pas-un-volume'), /volume invalide/)
})

test('tâches : statut, journal, arrêt', async () => {
  const status = await client.taskStatus('pve1', 'UPID:pve1:0005:running')
  assert.equal(status.status, 'running')
  const log = await client.taskLog('pve1', 'UPID:pve1:0001:task')
  assert.equal(log.length, 3)
  assert.match(log.at(-1).t, /TASK OK/)
  await client.taskStop('pve1', 'UPID:pve1:0005:running')
  assert.deepEqual(fake.actions.at(-1), { node: 'pve1', action: 'task-stop', upid: 'UPID:pve1:0005:running' })
  await assert.rejects(client.taskStatus('pve1', 'nimporte-quoi'), /tâche invalide/)
})

test('journal du nœud et alimentation', async () => {
  const lines = await client.syslog('pve1')
  assert.equal(lines.length, 2)
  assert.match(lines[0].t, /pvedaemon/)

  await client.nodePower('pve1', 'reboot')
  assert.deepEqual(fake.actions.at(-1), { node: 'pve1', action: 'node-power', command: 'reboot' })
  await assert.rejects(client.nodePower('pve1', 'explode'), /action inconnue/)
})

test('modèles LXC : liste et téléchargement', async () => {
  const list = await client.aplinfo('pve1')
  assert.equal(list.length, 2)
  assert.equal(list[0].package, 'debian-12-standard')

  await client.templateDownload('pve1', { storage: 'local', template: 'debian-12-standard_12.12-1_amd64.tar.zst' })
  assert.deepEqual(fake.actions.at(-1), {
    node: 'pve1', action: 'template-download', storage: 'local',
    template: 'debian-12-standard_12.12-1_amd64.tar.zst',
  })
  await assert.rejects(client.templateDownload('pve1', { storage: 'local', template: '../../x' }), /modèle invalide/)
})
