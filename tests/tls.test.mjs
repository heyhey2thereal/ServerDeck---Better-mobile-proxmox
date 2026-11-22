import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createClient } = require('../src/proxmox.js')

let server
let port
let tmp
let certPath

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'serverdeck-tls-'))
  certPath = path.join(tmp, 'cert.pem')
  const keyPath = path.join(tmp, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
  ], { stdio: 'ignore' })

  const { readFileSync } = await import('node:fs')
  server = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: { version: '8.2.4' } }))
    },
  )
  await new Promise((resolve) => server.listen(0, resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

test('certificat auto-signé accepté quand verifyTls est faux', async () => {
  const client = createClient({ host: 'localhost', port, scheme: 'https', verifyTls: false })
  const version = await client.version()
  assert.equal(version.version, '8.2.4')
})

test('certificat non vérifiable refusé quand verifyTls est vrai', async () => {
  const client = createClient({ host: 'localhost', port, scheme: 'https', verifyTls: true })
  await assert.rejects(client.version(), /certificate|self.signed|UNABLE_TO_VERIFY|SELF_SIGNED/i)
})

test('certificat accepté avec un ca explicite', async () => {
  const client = createClient({ host: 'localhost', port, scheme: 'https', verifyTls: true, ca: certPath })
  const version = await client.version()
  assert.equal(version.version, '8.2.4')
})
