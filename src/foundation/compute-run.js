/**
 * ⭐ A LOCAL RUN OF ONE COMPUTE FUNCTION, under the rules the public contract states for where it
 * runs: the web's globals and not Node's, no network, frozen built-in prototypes, a JSON input, an
 * answer that is a plain JSON object of bounded size, and a short time per call.
 *
 * A test that imports the file runs it in Node, which allows all of those; this run doesn't, so a
 * developer meets a failure here rather than in a run whose console output is discarded.
 *
 * ⚖️ It enforces the rules, not a copy of the platform's runner, which enforces them its own way.
 * A function that passes here keeps the contract; that is the claim, and no more.
 *
 * The limits are the platform's as of this writing (`LIMITS`). The time a call takes is measured
 * and compared with the budget, never cut at it, since this machine is not the one that runs it;
 * only a call that runs past `LIMITS.wallMs` is stopped.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { checkComputeSource } from './compute.js'

export const LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  answerBytes: 256 * 1024,
  cpuMs: 50,
  wallMs: 5000,
})

// An assignment to a property a frozen built-in prototype has (`error.name = 'X'`), or an addition
// to a frozen prototype itself.
const FROZEN = /Cannot assign to read only property|object is not extensible/
const FROZEN_HINT =
  '. The built-in prototypes are frozen, so assigning a property one of them has throws, as does adding to one.' +
  " Define the property instead: in an object literal, with Object.defineProperty, or as a class field (`class GradingError extends Error { name = 'GradingError' }`)."

const WORKER = new URL('./compute-run-worker.js', import.meta.url)

/**
 * Run `exportName` from the compute file at `file` on `inputText`.
 *
 * @param {object} p
 * @param {string} p.file - the compute file
 * @param {string} p.exportName - the function to call
 * @param {string} p.inputText - the input, as JSON text
 * @returns {Promise<{
 *   ok: boolean,
 *   answer?: object,
 *   failure?: string,
 *   problems?: string[],
 *   warnings: string[],
 *   wallMs?: number,
 *   cpuMs?: number,
 * }>} `ok` with the parsed `answer`, or not, with `failure` saying why in a sentence (and
 *   `problems` when the file itself can't be registered). `warnings` are the build's, and the
 *   budget's when the call took longer than it.
 */
export async function runComputeFunction({ file, exportName, inputText }) {
  const source = readFileSync(file, 'utf8')
  const { exports, problems, warnings } = await checkComputeSource(source)
  if (problems.length) {
    return { ok: false, failure: 'The file can\'t be registered, so it doesn\'t run:', problems, warnings }
  }
  if (!exports.includes(exportName)) {
    return {
      ok: false,
      failure: `The file doesn't export \`${exportName}\`. It exports ${exports.map((e) => `\`${e}\``).join(', ')}.`,
      warnings,
    }
  }

  const inputBytes = Buffer.byteLength(inputText)
  if (inputBytes > LIMITS.inputBytes) {
    return { ok: false, failure: `The input is ${kib(inputBytes)}, over the ${kib(LIMITS.inputBytes)} an input may be.`, warnings }
  }
  let input
  try {
    input = JSON.parse(inputText)
  } catch (err) {
    return { ok: false, failure: `The input isn't JSON: ${err.message}`, warnings }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, failure: 'The input is JSON but not an object: a function takes the object its integration\'s mapping writes.', warnings }
  }

  const outcome = await inWorker({ source, exportName, inputText })
  const timing = { wallMs: outcome.wallMs, cpuMs: outcome.cpuMs }
  const over = timingWarning(timing)
  const all = over ? [...warnings, over] : warnings

  switch (outcome.kind) {
    case 'answered': {
      const bytes = Buffer.byteLength(outcome.text)
      if (bytes > LIMITS.answerBytes) {
        return { ok: false, failure: `The answer is ${kib(bytes)}, over the ${kib(LIMITS.answerBytes)} an answer may be.`, warnings: all, ...timing }
      }
      return { ok: true, answer: JSON.parse(outcome.text), warnings: all, ...timing }
    }
    case 'threw':
      return {
        ok: false,
        failure: outcome.isError
          ? `It threw ${outcome.message}${FROZEN.test(outcome.message) ? FROZEN_HINT : ''}`
          : `It ${outcome.message}. Throw an Error with a message a person can read.`,
        warnings: all,
        ...timing,
      }
    case 'not-object':
      return { ok: false, failure: `It returned ${outcome.got}, not an object: an answer is a JSON object, or a promise of one.`, warnings: all, ...timing }
    case 'not-json':
      return { ok: false, failure: `Its answer can't be written as JSON: ${outcome.message}`, warnings: all, ...timing }
    case 'load-failed':
      return { ok: false, failure: `The file failed as it loaded: ${outcome.message}`, warnings: all }
    case 'not-exported':
      return { ok: false, failure: `The file doesn't export \`${exportName}\` as a function.`, warnings: all }
    case 'timed-out':
      return { ok: false, failure: `It was still running after ${LIMITS.wallMs / 1000} s, and was stopped.`, warnings: all, wallMs: LIMITS.wallMs }
    case 'unsettled':
      return { ok: false, failure: 'It returned a promise that never settles.', warnings: all }
    case 'crashed':
    default:
      return { ok: false, failure: `The run stopped: ${outcome.message}`, warnings: all }
  }
}

function inWorker(workerData) {
  return new Promise((resolve) => {
    // The function's console goes to stderr, here only: where it runs, it is discarded.
    const worker = new Worker(WORKER, { workerData, stdout: true, stderr: true })
    worker.stdout.pipe(process.stderr, { end: false })
    worker.stderr.pipe(process.stderr, { end: false })
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => settle({ kind: 'timed-out' }), LIMITS.wallMs)
    worker.once('message', settle)
    worker.once('error', (err) => settle({ kind: 'crashed', message: err?.message || String(err) }))
    worker.once('exit', () => settle({ kind: 'unsettled' }))
  })
}

function timingWarning({ wallMs, cpuMs }) {
  const spent = cpuMs ?? wallMs
  if (spent == null || spent <= LIMITS.cpuMs) return null
  return (
    `the call took ${Math.round(spent)} ms${cpuMs != null ? ' of CPU' : ''}, more than the ${LIMITS.cpuMs} ms one call may take where it runs. ` +
    'This machine is not that one, so measure again, but a function this slow is likely to be stopped there.'
  )
}

function kib(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
}
