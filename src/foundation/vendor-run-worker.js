/**
 * The worker a local run of a vendor function happens in (`vendor-run.js`). It takes away, before
 * the file loads, what §"What it can't do" of the public contract says a function doesn't have:
 *
 *   - Node's globals (`process`, `Buffer`, `setImmediate`, …), since it runs with the web's;
 *   - the network: `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` throw;
 *   - the built-in prototypes' writability: each is frozen, and a module is strict, so a write to
 *     one throws, including an assignment like `error.name = 'X'`.
 *
 * Then it imports the file as written, parses the input inside this realm, calls the function, and
 * posts back what came of it. The worker is the time limit's means too: the parent ends it.
 *
 * ⛔ Not a security boundary. It runs a developer's own file on their machine, to show them what it
 * would do under the contract's rules; it doesn't contain code that tries to get out.
 *
 * @module
 */

import { parentPort, workerData } from 'node:worker_threads'

// What this module needs, kept before the globals go.
const post = parentPort.postMessage.bind(parentPort)
const cpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage.bind(process) : null
const now = performance.now.bind(performance)

const { source, exportName, inputText } = workerData

// No top-level await: a promise that never settles is reported by the parent, not by Node.
main()

async function main() {
  // Load the module loader while Node's globals are still there: it reads them itself.
  await import('data:text/javascript,')

  // The language's own prototypes, frozen. A write to one throws in a module, which is strict.
  const INTRINSICS = [
    'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp',
    'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'Iterator',
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  ]
  const unnamed = (() => {
    const gen = function* () {}
    const agen = async function* () {}
    return [
      Object.getPrototypeOf(Int8Array).prototype,
      Object.getPrototypeOf(gen),
      Object.getPrototypeOf(gen).prototype,
      Object.getPrototypeOf(agen),
      Object.getPrototypeOf(agen).prototype,
      Object.getPrototypeOf(Object.getPrototypeOf(agen).prototype),
      Object.getPrototypeOf(async function () {}),
      Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
      Object.getPrototypeOf([][Symbol.iterator]()),
      Object.getPrototypeOf(new Map()[Symbol.iterator]()),
      Object.getPrototypeOf(new Set()[Symbol.iterator]()),
      Object.getPrototypeOf(''[Symbol.iterator]()),
      Object.getPrototypeOf(/x/[Symbol.matchAll]('')),
    ]
  })()
  for (const p of [...INTRINSICS.map((name) => globalThis[name]?.prototype), ...unnamed]) {
    if (p) Object.freeze(p)
  }

  // The network's globals throw, and Node's go: in that order, since replacing a network global
  // loads Node's implementation of it, which reads Node's globals.
  const NODE_ONLY = ['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate', 'require', 'module', 'exports', '__dirname', '__filename']
  const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']
  for (const name of NETWORK) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: function () {
        throw new TypeError(`${name} is not available: a vendor function has no network.`)
      },
    })
  }
  for (const name of NODE_ONLY) {
    try {
      delete globalThis[name]
    } catch {}
  }

  const report = (outcome) => post(outcome)

  let mod
  try {
    mod = await import(`data:text/javascript,${encodeURIComponent(source)}`)
  } catch (err) {
    report({ kind: 'load-failed', message: messageOf(err) })
  }

  if (mod) {
    const fn = mod[exportName]
    if (typeof fn !== 'function') {
      report({ kind: 'not-exported', exports: Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort() })
    } else {
      const input = JSON.parse(inputText)
      const cpuAt = cpu?.()
      const at = now()
      let outcome
      try {
        const answer = await fn(input)
        outcome = answerOutcome(answer)
      } catch (err) {
        outcome = { kind: 'threw', message: messageOf(err), isError: err instanceof Error }
      }
      outcome.wallMs = now() - at
      if (cpuAt) {
        const used = cpu(cpuAt)
        outcome.cpuMs = (used.user + used.system) / 1000
      }
      report(outcome)
    }
  }
}

function answerOutcome(answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return { kind: 'not-object', got: answer === null ? 'null' : Array.isArray(answer) ? 'an array' : typeof answer }
  }
  let text
  try {
    text = JSON.stringify(answer)
  } catch (err) {
    return { kind: 'not-json', message: messageOf(err) }
  }
  // What reaches the caller is the JSON, so judge that: a Date becomes a string, a Map `{}`.
  const sent = text === undefined ? undefined : JSON.parse(text)
  if (sent === null || typeof sent !== 'object' || Array.isArray(sent)) {
    return { kind: 'not-object', got: `${describe(answer)}, which becomes ${sent === undefined ? 'nothing' : JSON.stringify(sent).slice(0, 40)} as JSON` }
  }
  if (Object.prototype.toString.call(answer) !== '[object Object]') {
    return { kind: 'not-object', got: `${describe(answer)}, which becomes ${text.slice(0, 40)} as JSON` }
  }
  return { kind: 'answered', text }
}

function describe(value) {
  const tag = Object.prototype.toString.call(value).slice(8, -1)
  return `a ${tag}`
}

function messageOf(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return `threw a value that is not an Error: ${JSON.stringify(err)}`
  } catch {
    return 'threw a value that is not an Error'
  }
}
