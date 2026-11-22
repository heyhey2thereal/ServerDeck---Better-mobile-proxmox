#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const ssh = require('./ssh')
const { CONFIG_PATH } = require('./config')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return null
  const value = args[i + 1]
  return value && !value.startsWith('--') ? value : true
}
const has = (name) => args.includes(`--${name}`)

function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return Promise.resolve(fallback)
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(fallback ? `${question} [${fallback}] ` : `${question} `, (answer) => {
      rl.close()
      resolve(answer.trim() || fallback)
    })
  })
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[setup-pve] ${CONFIG_PATH} introuvable : lance d'abord \`npm run setup\`.`)
    process.exit(1)
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  if (config.proxmox && !has('force')) {
    console.error('[setup-pve] bloc "proxmox" déjà présent. Ajoute --force pour le remplacer.')
    process.exit(1)
  }

  const host = flag('host') || process.env.SERVERDECK_PVE_HOST || (await ask('Hôte Proxmox (IP ou nom) :'))
  if (!host || host === true) {
    console.error('[setup-pve] hôte requis (--host)')
    process.exit(1)
  }
  const port = Number(flag('port') || process.env.SERVERDECK_PVE_PORT || (await ask('Port de l\'API', '8006'))) || 8006
  // Jeton facultatif : sans jeton, l'application utilise le ticket de l'utilisateur
  // connecté (identifiants Proxmox) — aucun jeton à créer.
  let tokenId = flag('token-id')
  let tokenSecret = flag('token-secret')
  if (tokenId === true || tokenSecret === true) {
    console.error('[setup-pve] --token-id et --token-secret attendent une valeur')
    process.exit(1)
  }
  if ((tokenId && !tokenSecret) || (!tokenId && tokenSecret)) {
    console.error('[setup-pve] fournis --token-id ET --token-secret, ou aucun des deux')
    process.exit(1)
  }

  const sshUser = flag('ssh-user') || (await ask('Utilisateur SSH', 'root'))
  const sshPort = Number(flag('ssh-port') || (await ask('Port SSH', '22'))) || 22
  const keyPath = flag('key') || path.join(os.homedir(), '.ssh', 'serverdeck_ed25519')

  const key = await ssh.ensureKey(keyPath)

  config.proxmox = {
    host,
    port,
    scheme: flag('scheme') || 'https',
    // false par défaut : le certificat Proxmox est auto-signé, il est épinglé au
    // premier contact (config.proxmox.cert). --verify-tls pour un vrai certificat.
    verifyTls: has('verify-tls'),
    ...(tokenId ? { tokenId, tokenSecret } : {}),
    ssh: { user: sshUser, port: sshPort, keyPath },
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })

  console.log('\n  Proxmox configuré :', `${config.proxmox.scheme}://${host}:${port}`)
  console.log('  Authentification :', tokenId ? 'jeton d\'API' : 'identifiants Proxmox (au login)')
  console.log('  Clé SSH           :', keyPath, key.created ? '(créée)' : '(existante)')
  console.log('\n  À exécuter en root sur le nœud Proxmox :\n')
  console.log(`    bash proxmox-setup.sh '${key.publicKey}'\n`)
  console.log('  (le script crée le rôle, le jeton, la commande restreinte et autorise la clé)\n')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
