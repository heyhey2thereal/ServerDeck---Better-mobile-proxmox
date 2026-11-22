import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStore, sanitizeName } = require('../src/files.js')

function tmpStore(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serverdeck-files-'))
  const store = createStore({ dir, secret: 'secret-de-test', ...options })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('noms de fichiers : acceptés et refusés', () => {
  for (const name of ['notes.txt', 'Debian 12.iso', 'archive_2024-01.tar.gz', 'café.pdf', 'a'.repeat(120)]) {
    assert.equal(sanitizeName(name), name, name)
  }
  for (const name of ['../etc/passwd', 'a/b', 'a\\b', '.hidden', '.', '..', '', '   ', 'x'.repeat(121), 'a\u0000b', 'ligne\nretour']) {
    assert.equal(sanitizeName(name), null, JSON.stringify(name))
  }
  assert.equal(sanitizeName(42), null)
})

test('écriture, liste, renommage et suppression', async () => {
  const { dir, store, cleanup } = tmpStore()
  try {
    const saved = await store.save('notes.txt', Readable.from([Buffer.from('bonjour')]))
    assert.equal(saved.name, 'notes.txt')
    assert.equal(saved.size, 7)
    assert.equal(readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'bonjour')
    assert.deepEqual(store.list().map((file) => file.name), ['notes.txt'])

    await store.save('notes.txt', Readable.from([Buffer.from('remplacé')]))
    assert.equal(readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'remplacé')
    assert.equal(store.list().length, 1)

    const renamed = store.rename('notes.txt', 'notes-2.txt')
    assert.equal(renamed.name, 'notes-2.txt')
    assert.deepEqual(store.list().map((file) => file.name), ['notes-2.txt'])

    store.remove('notes-2.txt')
    assert.deepEqual(store.list(), [])
    assert.equal(store.stat('notes-2.txt'), null)
  } finally {
    cleanup()
  }
})

test('les fichiers temporaires restent invisibles', async () => {
  const { dir, store, cleanup } = tmpStore()
  try {
    await store.save('ok.txt', Readable.from([Buffer.from('x')]))
    assert.ok(readdirSync(dir).every((name) => !name.startsWith('.') || name === 'ok.txt'))
    assert.deepEqual(store.list().map((file) => file.name), ['ok.txt'])
  } finally {
    cleanup()
  }
})

test('taille maximale : refus et aucun fichier partiel', async () => {
  const { dir, store, cleanup } = tmpStore({ maxBytes: 1024 })
  try {
    await assert.rejects(
      store.save('gros.bin', Readable.from([Buffer.alloc(2048)])),
      (err) => err.status === 413,
    )
    await assert.rejects(
      store.save('gros.bin', Readable.from([Buffer.alloc(10)]), { declared: 4096 }),
      (err) => err.status === 413,
    )
    assert.deepEqual(readdirSync(dir), [])
    assert.deepEqual(store.list(), [])
  } finally {
    cleanup()
  }
})

test('nom de fichier invalide refusé par le stockage', async () => {
  const { store, cleanup } = tmpStore()
  try {
    assert.throws(() => store.resolveName('../../etc/passwd'), (err) => err.status === 400)
    await assert.rejects(
      store.save('a/b', Readable.from([Buffer.from('x')])),
      (err) => err.status === 400,
    )
    assert.throws(() => store.remove('..'), (err) => err.status === 400)
    assert.throws(() => store.remove('absent.txt'), (err) => err.status === 404)
  } finally {
    cleanup()
  }
})

test('jetons de téléchargement signés', () => {
  const { store, cleanup } = tmpStore()
  try {
    const { token, exp } = store.signToken('fichier.bin', 3600_000)
    assert.ok(exp > Date.now())
    assert.equal(store.verifyToken('fichier.bin', token), true)
    assert.equal(store.verifyToken('autre.bin', token), false)
    assert.equal(store.verifyToken('fichier.bin', 'nimporte-quoi'), false)
    assert.equal(store.verifyToken('fichier.bin', ''), false)

    const forged = `${Date.now() + 3600_000}.${'A'.repeat(43)}`
    assert.equal(store.verifyToken('fichier.bin', forged), false)

    const expired = store.signToken('fichier.bin', -3600_000)
    assert.equal(store.verifyToken('fichier.bin', expired.token), false)
  } finally {
    cleanup()
  }
})
