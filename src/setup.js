#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { hashPassword, totpUri } = require('./auth')
const { CONFIG_PATH } = require('./config')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1] ?? true
}

function randomPassword(bytes = 12) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.randomBytes(bytes), (b) => alphabet[b % alphabet.length]).join('')
}

function randomTotpSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join('')
}

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (silent) {
      rl._writeToOutput = () => rl.output.write(question)
      rl.question(question, (answer) => {
        rl.output.write('\n')
        rl.close()
        resolve(answer)
      })
    } else {
      rl.question(question, (answer) => {
        rl.close()
        resolve(answer)
      })
    }
  })
}

async function main() {
  const exists = fs.existsSync(CONFIG_PATH)
  if (exists && !args.includes('--force')) {
    console.error(`[setup] ${CONFIG_PATH} existe déjà. Utilise --force pour l'écraser.`)
    process.exit(1)
  }

  let password = flag('password')
  if (!password) password = randomPassword()
  if (typeof password !== 'string' || password.length < 10) {
    console.error('[setup] mot de passe trop court (10 caractères minimum)')
    process.exit(1)
  }

  let totpSecret
  if (args.includes('--no-totp')) {
    totpSecret = null
  } else if (args.includes('--totp')) {
    const value = flag('totp')
    totpSecret = value === true ? randomTotpSecret() : value
  } else if (process.stdin.isTTY) {
    const answer = await ask('Activer la double authentification TOTP ? [O/n] ')
    totpSecret = /^n/i.test(answer.trim()) ? null : randomTotpSecret()
  } else {
    totpSecret = randomTotpSecret()
  }

  const port = Number(flag('port')) || 8090
  const bind = flag('bind') || '0.0.0.0'

  const config = {
    port,
    bind,
    passwordHash: hashPassword(password),
    totpSecret,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    sessionHours: 168,
    trustProxy: false,
    shell: '/bin/bash',
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })

  const shown = flag('password') ? '(celle fournie)' : password
  console.log('')
  console.log(`  config     : ${CONFIG_PATH} (0600)`)
  console.log(`  écoute     : ${bind}:${port}`)
  console.log(`  mot de passe : ${shown}`)
  if (totpSecret) {
    console.log(`  TOTP secret  : ${totpSecret}`)
    console.log(`  TOTP uri     : ${totpUri(totpSecret, `${os.userInfo().username}@${os.hostname()}`)}`)
  } else {
    console.log('  TOTP       : désactivé')
  }
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
