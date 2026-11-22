const fs = require('fs')
const path = require('path')

const CONFIG_PATH = process.env.SERVERDECK_CONFIG || path.join(__dirname, '..', 'config.json')

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[serverdeck] config introuvable : ${CONFIG_PATH}`)
    console.error('[serverdeck] lance `npm run setup` pour la créer.')
    process.exit(1)
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  if (!cfg.passwordHash) throw new Error('config: passwordHash manquant (npm run setup)')
  if (!cfg.sessionSecret) throw new Error('config: sessionSecret manquant (npm run setup)')
  return {
    port: Number(cfg.port) || 8090,
    bind: cfg.bind || '0.0.0.0',
    passwordHash: cfg.passwordHash,
    totpSecret: cfg.totpSecret || null,
    sessionSecret: cfg.sessionSecret,
    sessionHours: Number(cfg.sessionHours) || 168,
    trustProxy: Boolean(cfg.trustProxy),
    allowFrame: Boolean(cfg.allowFrame),
    shell: cfg.shell || '/bin/bash',
    cwd: cfg.cwd || null,
    publicUrl: cfg.publicUrl || null,
    proxmox: cfg.proxmox || null,
    mdns: cfg.mdns || null,
  }
}

function save(mutator) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  mutator(raw)
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  return raw
}

module.exports = { load, save, CONFIG_PATH }
