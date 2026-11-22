const crypto = require('crypto')

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = stored.split('$')
    if (algo !== 'scrypt') return false
    const expected = Buffer.from(hashB64, 'base64')
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    })
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    const idx = B32.indexOf(char)
    if (idx === -1) throw new Error('secret TOTP invalide')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

function totpAt(secret, counter) {
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(bin % 1e6).padStart(6, '0')
}

function verifyTotp(secret, code, window = 1) {
  if (!secret) return true
  if (!/^\d{6}$/.test(String(code || '').trim())) return false
  const counter = Math.floor(Date.now() / 30000)
  const given = String(code).trim()
  for (let i = -window; i <= window; i++) {
    const candidate = totpAt(secret, counter + i)
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(given))) return true
  }
  return false
}

function totpUri(secret, label, issuer = 'ServerDeck') {
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: '6', period: '30',
  })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function createSessionToken(secret, hours, user = null, sid = null) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + hours * 3600_000,
    u: user,
    s: sid,
  })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

function readSession(token, secret) {
  if (!verifySessionToken(token, secret)) return null
  const [payload] = String(token).split('.')
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return Number(data.exp) > Date.now() ? { user: data.u || null, sid: data.s || null } : null
  } catch {
    return null
  }
}

function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return false
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return false
  const expected = sign(payload, secret)
  if (expected.length !== mac.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return Number(exp) > Date.now()
  } catch {
    return false
  }
}

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

class RateLimiter {
  constructor(maxAttempts = 6, windowMs = 10 * 60_000) {
    this.max = maxAttempts
    this.windowMs = windowMs
    this.entries = new Map()
  }

  check(key) {
    const entry = this.entries.get(key)
    if (!entry || entry.resetAt < Date.now()) return { blocked: false, remaining: this.max }
    if (entry.count >= this.max) return { blocked: true, retryAfter: Math.ceil((entry.resetAt - Date.now()) / 1000) }
    return { blocked: false, remaining: this.max - entry.count }
  }

  fail(key) {
    const entry = this.entries.get(key)
    if (!entry || entry.resetAt < Date.now()) {
      this.entries.set(key, { count: 1, resetAt: Date.now() + this.windowMs })
    } else {
      entry.count += 1
    }
    if (this.entries.size > 5000) this.entries.clear()
  }

  reset(key) {
    this.entries.delete(key)
  }
}

module.exports = {
  hashPassword, verifyPassword, verifyTotp, totpAt, totpUri,
  createSessionToken, verifySessionToken, readSession, parseCookies, RateLimiter,
}
