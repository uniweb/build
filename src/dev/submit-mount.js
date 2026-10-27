import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import { YAML_OPTIONS } from '../utils/yaml-schema.js'
import { readServicesRequest } from '../uwx/services-request.js'

/**
 * Where `uniweb dev` answers the site's `submit` service when site.yml asks its host for
 * one. The dev server is the host here, so the address is its own.
 */
export const DEV_SUBMIT_ADDRESS = '/_submit'

/** Where the dev server keeps what it is sent: under the site's `.uniweb/`, which is never committed. */
export const DEV_SUBMISSIONS_DIR = join('.uniweb', 'dev-submissions')

/**
 * Take a site's form submissions in the dev server.
 *
 * `services: { submit: true }` asks the site's HOST to take its forms, and a component
 * draws a form only when something does (`useFormSubmit().canSubmit`). In `uniweb dev`
 * the dev server is the host, so it answers: the form shows, and it can be filled in and
 * sent before the site is published. Each submission is printed in the terminal and kept,
 * attachments and all, under the site's `.uniweb/dev-submissions/`.
 *
 * ⭐ Only when the site asks its host. An address of the site's own (`submit: https://…`)
 * is its provider in development as everywhere, and `submit: false` or no entry means
 * the site takes no forms — so neither is answered here.
 *
 * Unlike `mountDevApi`, which mounts whatever handler a site names, this one knows what
 * it is answering: the protocol kit's `submitForm` speaks — a create call with the
 * answers and a manifest of attachments, then for each attachment `upload` (raw bytes,
 * `X-Submission-Id` and `X-Slot`) and a closing `finalize`. That wire is the framework's
 * own, so the framework can receive it.
 *
 * ⛔ Development only. Nothing a build reads names this address; only the dev payload
 * does, as `config.submit` — the site tier, which `resolveService` reads when no host
 * speaks (the same seam as `$devBackend`).
 *
 * ⚠️ Registered synchronously, before Vite's own middleware, for the reason `mountDevApi`
 * gives: after it, the SPA fallback would answer a POST with `index.html`.
 *
 * @param {import('vite').ViteDevServer} server
 * @param {object} options
 * @param {string} options.root - the site directory
 * @param {string} [options.base] - the site's base path, which a request may still carry
 * @param {(line: string) => void} [options.log]
 * @returns {string|null} the address it answers on, or null when the site asks for none
 */
export function mountDevSubmit(server, { root, base = '/', log = console.log } = {}) {
  let site
  try {
    site = yaml.load(readFileSync(join(root, 'site.yml'), 'utf8'), YAML_OPTIONS) || {}
  } catch {
    return null
  }
  const ask = readServicesRequest(site.services)?.find((row) => row.name === 'submit')
  if (!ask || ask.enabled === false) return null

  const prefix = DEV_SUBMIT_ADDRESS
  const dir = join(root, DEV_SUBMISSIONS_DIR)
  const slotsOf = new Map() // submissionId → the manifest its create call sent, to name each upload

  server.middlewares.use(async (req, res, next) => {
    const path = withoutBase((req.url || '').split('?')[0], base)
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return next()

    const reply = (status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return reply(405, { error: 'A form is sent with POST.' })

    const step = path.slice(prefix.length).replace(/\/+$/, '')
    const bytes = await readBody(req)

    if (step === '') {
      let body
      try {
        body = JSON.parse(bytes.toString('utf8'))
      } catch {
        return reply(400, { error: 'The submission is not JSON.' })
      }
      if (!isMap(body?.formData)) return reply(400, { error: 'A submission carries its answers as a `formData` object.' })

      const receivedAt = new Date().toISOString()
      const submissionId = `${receivedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
      const files = Array.isArray(body.fileSlots) ? body.fileSlots : []
      const record = { submissionId, receivedAt, formId: body.formId ?? null, formData: body.formData, metadata: body.metadata ?? {}, files }
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${submissionId}.json`), `${JSON.stringify(record, null, 2)}\n`)
      if (files.length) slotsOf.set(submissionId, files)

      log(`[dev-submit] ${describe(record)} → ${join(DEV_SUBMISSIONS_DIR, `${submissionId}.json`)}`)
      return reply(200, { submissionId })
    }

    if (step === '/upload') {
      const id = String(req.headers['x-submission-id'] || '')
      const slot = Number(req.headers['x-slot'])
      const slots = slotsOf.get(id)
      if (!slots || !Number.isInteger(slot) || slot < 0 || slot >= slots.length) {
        return reply(400, { error: 'An upload names a submission this server took, and one of its slots.' })
      }
      mkdirSync(join(dir, id), { recursive: true })
      writeFileSync(join(dir, id, `${slot}-${safeName(slots[slot]?.name) || 'file'}`), bytes)
      return reply(200, { ok: true })
    }

    if (step === '/finalize') return reply(200, { ok: true })

    return reply(404, { error: `Nothing answers ${path} here.` })
  })

  log(`[dev-submit] taking the site's forms at ${prefix}; what they send is kept in ${DEV_SUBMISSIONS_DIR}/`)
  return prefix
}

/** One line for the terminal: which form, the summary it sent, how many answers. */
function describe({ formId, formData, metadata, files }) {
  const preview = metadata?.preview || {}
  const said = [preview.title, preview.subtitle].filter((x) => typeof x === 'string' && x.trim()).join(' · ')
  const answers = Object.keys(formData).length
  const attached = files.length ? `, ${files.length} attachment${files.length === 1 ? '' : 's'}` : ''
  return `${formId || 'form'}${said ? ` — ${said}` : ''} (${answers} answer${answers === 1 ? '' : 's'}${attached})`
}

/** A request may still carry the site's base path; the address is the dev server's own. */
function withoutBase(path, base) {
  const prefix = String(base || '/').replace(/\/+$/, '')
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path
}

/** A file's own name, never a path: what it is called is the visitor's to say, where it goes is not. */
function safeName(name) {
  return basename(String(name || '').replace(/\\/g, '/')).replace(/^\.+/, '')
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
