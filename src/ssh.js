const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawnSync } = require('child_process')
const pty = require('node-pty')

const VMID_RE = /^\d{1,9}$/

let sshAvailable = null

function ensureSshBinary() {
  if (sshAvailable === null) {
    sshAvailable = !spawnSync('ssh', ['-V'], { stdio: 'ignore' }).error
  }
  if (!sshAvailable) throw new Error('commande « ssh » introuvable : installe openssh-client')
}

function sshConfig(cfg) {
  const ssh = (cfg && cfg.ssh) || {}
  return {
    user: ssh.user || 'root',
    port: Number(ssh.port) || 22,
    keyPath: ssh.keyPath || path.join(os.homedir(), '.ssh', 'serverdeck_ed25519'),
    knownHosts: ssh.knownHosts || path.join(os.homedir(), '.ssh', 'known_hosts'),
  }
}

function sshArgs(cfg, remoteCommand) {
  const ssh = sshConfig(cfg)
  fs.mkdirSync(path.dirname(ssh.knownHosts), { recursive: true })
  return [
    '-tt',
    '-p', String(ssh.port),
    '-i', ssh.keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${ssh.knownHosts}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    `${ssh.user}@${cfg.host}`,
    remoteCommand,
  ]
}

function spawnRemote(cfg, remoteCommand, { cols = 80, rows = 24 } = {}) {
  if (!cfg || !cfg.host) throw new Error('Proxmox non configuré')
  ensureSshBinary()
  return pty.spawn('ssh', sshArgs(cfg, remoteCommand), {
    name: 'xterm-256color',
    cols,
    rows,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })
}

function spawnContainerShell(cfg, vmid, options = {}) {
  if (!VMID_RE.test(String(vmid))) throw new Error('identifiant de conteneur invalide')
  return spawnRemote(cfg, `ct ${vmid}`, options)
}

function spawnHostShell(cfg, options = {}) {
  return spawnRemote(cfg, 'host', options)
}

function ensureKey(keyPath = sshConfig(null).keyPath) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  if (fs.existsSync(keyPath)) {
    return Promise.resolve({ created: false, publicKey: readPublicKey(keyPath) })
  }
  return new Promise((resolve, reject) => {
    execFile(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', 'serverdeck', '-f', keyPath],
      (err) => {
        if (err) return reject(new Error(`ssh-keygen : ${err.message}`))
        fs.chmodSync(keyPath, 0o600)
        resolve({ created: true, publicKey: readPublicKey(keyPath) })
      },
    )
  })
}

function readPublicKey(keyPath) {
  const pub = `${keyPath}.pub`
  if (!fs.existsSync(pub)) return null
  return fs.readFileSync(pub, 'utf8').trim()
}

module.exports = { spawnContainerShell, spawnHostShell, ensureKey, readPublicKey, sshConfig }
