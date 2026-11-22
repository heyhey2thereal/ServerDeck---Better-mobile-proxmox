const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MAX_NAME = 120

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// Un nom de fichier est un nom, pas un chemin : pas de séparateur, pas de
// caractère de contrôle, pas de nom caché (les fichiers temporaires d'envoi
// commencent par un point et doivent rester invisibles).
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.normalize('NFC').trim()
  if (!name || name.length > MAX_NAME) return null
  if (name.startsWith('.') || name === '.' || name === '..') return null
  if (/[\/\\\x00-\x1f\x7f]/.test(name)) return null
  if (!/[^\s.]/.test(name)) return null
  return name
}

function createStore({ dir, maxBytes = 512 * 1024 * 1024, secret = '' } = {}) {
  if (!dir) throw new Error('createStore : dossier manquant')
  const root = path.resolve(dir)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })

  function resolveName(raw) {
    const name = sanitizeName(raw)
    if (!name) throw httpError(400, 'nom de fichier invalide')
    const full = path.join(root, name)
    if (path.dirname(full) !== root) throw httpError(400, 'nom de fichier invalide')
    return { name, full }
  }

  function entryOf(name, full) {
    const st = fs.statSync(full)
    return { name, size: st.size, mtime: st.mtimeMs }
  }

  function list() {
    let dirents
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    const files = []
    for (const dirent of dirents) {
      if (!dirent.isFile() || dirent.name.startsWith('.')) continue
      try {
        files.push(entryOf(dirent.name, path.join(root, dirent.name)))
      } catch {}
    }
    files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    return files
  }

  function stat(name) {
    const { full } = resolveName(name)
    try {
      return entryOf(name, full)
    } catch {
      return null
    }
  }

  // Écrit dans un fichier temporaire puis renomme : un envoi interrompu ne
  // laisse jamais un fichier tronqué à la place de l'ancien.
  function save(name, readable, { declared = 0 } = {}) {
    let full
    try {
      full = resolveName(name).full
    } catch (err) {
      return Promise.reject(err)
    }
    if (declared > maxBytes) {
      return Promise.reject(httpError(413, `fichier trop gros (max ${maxBytes} octets)`))
    }
    return new Promise((resolve, reject) => {
      const tmp = path.join(root, `.upload-${crypto.randomBytes(8).toString('hex')}`)
      const out = fs.createWriteStream(tmp, { mode: 0o600 })
      let bytes = 0
      let settled = false

      const fail = (err) => {
        if (settled) return
        settled = true
        try { readable.unpipe(out) } catch {}
        try { readable.destroy() } catch {}
        // Le fichier temporaire n'existe qu'une fois le flux ouvert : on attend
        // sa fermeture avant de le supprimer, sinon un envoi refusé très vite
        // laisse une coquille vide derrière lui.
        const cleanup = () => {
          try { fs.unlinkSync(tmp) } catch {}
          reject(err)
        }
        if (out.closed) return cleanup()
        out.once('close', cleanup)
        out.destroy()
      }

      readable.on('error', fail)
      readable.on('aborted', () => fail(httpError(499, 'envoi interrompu')))
      readable.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) fail(httpError(413, `fichier trop gros (max ${maxBytes} octets)`))
      })
      out.on('error', fail)
      out.on('close', () => {
        if (settled) return
        if (!readable.readableEnded) return fail(httpError(499, 'envoi interrompu'))
        settled = true
        try {
          fs.chmodSync(tmp, 0o600)
          fs.renameSync(tmp, full)
        } catch (err) {
          try { fs.unlinkSync(tmp) } catch {}
          return reject(err)
        }
        try {
          resolve(entryOf(name, full))
        } catch (err) {
          reject(err)
        }
      })
      readable.pipe(out)
    })
  }

  function remove(name) {
    const { full } = resolveName(name)
    try {
      fs.unlinkSync(full)
    } catch (err) {
      if (err.code === 'ENOENT') throw httpError(404, 'fichier introuvable')
      throw err
    }
  }

  function rename(from, to) {
    const src = resolveName(from)
    const dst = resolveName(to)
    if (src.full === dst.full) return entryOf(dst.name, dst.full)
    if (!fs.existsSync(src.full)) throw httpError(404, 'fichier introuvable')
    if (fs.existsSync(dst.full)) throw httpError(409, 'un fichier porte déjà ce nom')
    fs.renameSync(src.full, dst.full)
    return entryOf(dst.name, dst.full)
  }

  function free() {
    try {
      const st = fs.statfsSync(root)
      return st.bavail * st.bsize
    } catch {
      return null
    }
  }

  // Lien de téléchargement signé : un conteneur n'a pas de cookie de session,
  // il lui faut une URL autonome, limitée dans le temps et liée au fichier.
  function signToken(name, ttlMs = 24 * 3600_000) {
    const exp = Date.now() + Number(ttlMs)
    const mac = crypto.createHmac('sha256', secret).update(`${name}\n${exp}`).digest('base64url')
    return { token: `${exp}.${mac}`, exp }
  }

  function verifyToken(name, token) {
    if (!secret || typeof token !== 'string') return false
    const [expPart, mac] = token.split('.')
    const exp = Number(expPart)
    if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false
    const expected = crypto.createHmac('sha256', secret).update(`${name}\n${exp}`).digest('base64url')
    const given = Buffer.from(mac)
    const wanted = Buffer.from(expected)
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
  }

  return { root, maxBytes, list, stat, save, remove, rename, free, signToken, verifyToken, resolveName }
}

module.exports = { createStore, sanitizeName, MAX_NAME }
