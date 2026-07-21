/**
 * Shared deploy-hook plumbing
 *
 * Every host adapter that ships a `deploy` hook drives a third-party CLI
 * (`aws`, `wrangler`, `netlify`, `vercel`, `git`). They all need the same
 * three things:
 *
 *   1. A structured error the CLI layer can render. `deploy.js` keys off
 *      `err.name === 'DeployError'` to print `message` + an indented
 *      `hint` block instead of a stack trace, so the class name is part
 *      of the contract — don't rename it.
 *   2. ENOENT translated into "here's how to install that tool", which is
 *      the single most common failure for a first-time deploy.
 *   3. A non-zero exit translated into something actionable. That part is
 *      tool-specific, so `spawnTool` takes an optional `translate`
 *      callback and falls back to a generic message carrying stderr.
 *
 * Adapters own their translations; this module owns the mechanics.
 */

import { spawn } from 'node:child_process'

/**
 * Error shape the CLI renders specially. `hint` is a pre-formatted
 * multi-line block printed verbatim under the message.
 */
export class DeployError extends Error {
  constructor(message, { hint } = {}) {
    super(message)
    this.name = 'DeployError'
    this.hint = hint
  }
}

/**
 * Run a CLI tool, streaming stdout to `log` and capturing stderr for
 * error translation.
 *
 * @param {string} cmd — Executable name, resolved on PATH.
 * @param {string[]} args
 * @param {object} opts
 * @param {Record<string,string>} [opts.env]
 * @param {(msg: string) => void} [opts.log]
 * @param {string} [opts.cwd]
 * @param {string} [opts.install] — Install instructions used to build the
 *   ENOENT hint. Strongly recommended: a missing tool is the most common
 *   first-run failure and a bare "command not found" is a dead end.
 * @param {(code: number, stderr: string) => DeployError|null} [opts.translate]
 *   Maps a non-zero exit to a specific DeployError. Return null to fall
 *   through to the generic message.
 * @param {boolean} [opts.quiet] — Capture stdout without echoing it.
 * @returns {Promise<{stdout: string, stderr: string}>}
 * @throws {DeployError}
 */
export function spawnTool(cmd, args, opts = {}) {
  const { env, log = () => {}, cwd, install, translate, quiet = false } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString()
      stdout += s
      if (!quiet) log(s.replace(/\n$/, ''))
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new DeployError(
          `\`${cmd}\` is not installed or not on PATH.`,
          { hint: install || `Install ${cmd} and make sure it's on your PATH, then retry.` }
        ))
        return
      }
      reject(err)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const specific = translate ? translate(code, stderr) : null
      if (specific) {
        reject(specific)
        return
      }
      const tail = stderr.trim() || stdout.trim()
      reject(new DeployError(
        `\`${cmd} ${args[0] ?? ''}\` failed (exit ${code}).`,
        { hint: tail ? tail.split('\n').slice(-20).join('\n') : undefined }
      ))
    })
  })
}

/**
 * Read a credential from the resolved deploy target first, then the
 * environment. Adapters accept tokens either way: `deploy.yml` is
 * committed, so a token belongs in the environment — but the config path
 * exists for values that are merely identifiers (account/site/project
 * ids), which are safe to commit and tedious to re-export per shell.
 *
 * @param {object} deployConfig
 * @param {Record<string,string>} env
 * @param {string} configKey
 * @param {string|string[]} envKeys — Checked in order.
 * @returns {string|undefined}
 */
export function readCredential(deployConfig, env, configKey, envKeys) {
  const fromConfig = deployConfig?.[configKey]
  if (fromConfig) return String(fromConfig)
  for (const key of [envKeys].flat()) {
    if (env?.[key]) return env[key]
  }
  return undefined
}

/**
 * Build the "set this and retry" hint for a missing credential. Kept in
 * one place so every adapter phrases it the same way.
 *
 * @param {object} spec
 * @param {string} spec.what — Human name, e.g. 'a Cloudflare API token'.
 * @param {string[]} spec.envVars
 * @param {string} [spec.configKey] — deploy.yml key, when committing the
 *   value is safe (ids, not secrets).
 * @param {string} [spec.docsUrl]
 * @returns {string}
 */
export function credentialHint({ what, envVars, configKey, docsUrl }) {
  const lines = [`Provide ${what}:`]
  for (const v of envVars) lines.push(`  export ${v}=…`)
  if (configKey) {
    lines.push('')
    lines.push(`Or set \`${configKey}\` on the target in deploy.yml (safe to commit — it's an id, not a secret).`)
  }
  if (docsUrl) {
    lines.push('')
    lines.push(docsUrl)
  }
  return lines.join('\n')
}
