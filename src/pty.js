const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const pty = require('node-pty')

const PREFIX = 'sd_'
const NAME_RE = /^[a-zA-Z0-9_-]{1,24}$/
// Socket tmux dédié : la config et les sessions de ServerDeck ne touchent pas
// celles de l'utilisateur.
const SOCKET = ['-L', 'serverdeck']
const CONF = path.join(__dirname, '..', 'tmux.conf')

function tmuxSession(name) {
  if (!NAME_RE.test(name)) throw new Error('nom de session invalide (a-z, 0-9, -, _)')
  return PREFIX + name
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', [...SOCKET, ...args], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message))
      resolve(stdout)
    })
  })
}

async function listSessions() {
  let stdout
  try {
    stdout = await tmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}'])
  } catch (err) {
    if (/no server running|failed to connect/i.test(err.message)) return []
    throw err
  }
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, attached, created] = line.split('\t')
      return { name: name.slice(PREFIX.length), attached: Number(attached) > 0, createdAt: Number(created) * 1000 }
    })
    .filter((s) => s.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function ensureSession(name) {
  const session = tmuxSession(name)
  try {
    await tmux(['has-session', '-t', `=${session}`])
  } catch {
    await tmux(['new-session', '-d', '-s', session, '-c', os.homedir()])
  }
  return name
}

async function killSession(name) {
  await tmux(['kill-session', '-t', `=${tmuxSession(name)}`])
}

function attach(name, { cols = 80, rows = 24, shell = '/bin/bash', cwd = os.homedir() } = {}) {
  const session = tmuxSession(name)
  // -D : un nouveau client détache les précédents, sinon un client zombie garde
  // la taille de la session figée.
  return pty.spawn('tmux', [...SOCKET, '-f', CONF, 'new-session', '-AD', '-s', session, '-c', cwd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })
}

module.exports = { listSessions, ensureSession, killSession, attach, tmuxSession }
