import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const auth = require('../src/auth.js')

// Vecteurs RFC 6238 (SHA1) : T = 59 s, 1111111109 s, ... soit les compteurs 30 s ci-dessous.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const VECTORS = [
  [1, '287082'],
  [37037036, '081804'],
  [37037037, '050471'],
  [41152263, '005924'],
  [66666666, '279037'],
  [666666666, '353130'],
]

test('TOTP respecte les vecteurs RFC 6238', () => {
  for (const [counter, expected] of VECTORS) {
    assert.equal(auth.totpAt(RFC_SECRET, counter), expected, `compteur ${counter}`)
  }
})

test('mot de passe : haché puis vérifié', () => {
  const stored = auth.hashPassword('mot-de-passe-solide')
  assert.match(stored, /^scrypt\$/)
  assert.equal(auth.verifyPassword('mot-de-passe-solide', stored), true)
  assert.equal(auth.verifyPassword('mauvais', stored), false)
  assert.equal(auth.verifyPassword('mot-de-passe-solide', 'nimporte-quoi'), false)
})

test('mot de passe : deux hachages diffèrent (sel aléatoire)', () => {
  assert.notEqual(auth.hashPassword('abc1234567'), auth.hashPassword('abc1234567'))
})

test('TOTP : code courant accepté, code voisin accepté, code faux refusé', () => {
  const now = Math.floor(Date.now() / 30000)
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totpAt(RFC_SECRET, now)), true)
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totpAt(RFC_SECRET, now - 1)), true)
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totpAt(RFC_SECRET, now + 5)), false)
  assert.equal(auth.verifyTotp(RFC_SECRET, '000000'), auth.totpAt(RFC_SECRET, now) === '000000')
  assert.equal(auth.verifyTotp(RFC_SECRET, 'abc'), false)
  assert.equal(auth.verifyTotp(null, ''), true)
})

test('jeton de session : valide, falsifié refusé, expiré refusé', () => {
  const secret = 'a'.repeat(64)
  const token = auth.createSessionToken(secret, 1)
  assert.equal(auth.verifySessionToken(token, secret), true)
  assert.equal(auth.verifySessionToken(token, 'b'.repeat(64)), false)
  const [payload, mac] = token.split('.')
  assert.equal(auth.verifySessionToken(`${payload}.${mac.slice(0, -2)}xx`, secret), false)
  const expired = auth.createSessionToken(secret, -1)
  assert.equal(auth.verifySessionToken(expired, secret), false)
  assert.equal(auth.verifySessionToken(undefined, secret), false)
})

test('limiteur de tentatives : blocage après 6 échecs puis réinitialisation', () => {
  const limiter = new auth.RateLimiter(3, 60_000)
  assert.equal(limiter.check('1.2.3.4').blocked, false)
  limiter.fail('1.2.3.4')
  limiter.fail('1.2.3.4')
  limiter.fail('1.2.3.4')
  assert.equal(limiter.check('1.2.3.4').blocked, true)
  assert.equal(limiter.check('5.6.7.8').blocked, false)
  limiter.reset('1.2.3.4')
  assert.equal(limiter.check('1.2.3.4').blocked, false)
})

test('cookies : analyse simple et valeurs encodées', () => {
  assert.deepEqual(auth.parseCookies('a=1; sd=xyz'), { a: '1', sd: 'xyz' })
  assert.deepEqual(auth.parseCookies(''), {})
  assert.equal(auth.parseCookies('x=a%20b').x, 'a b')
})
