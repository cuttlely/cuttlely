import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '../errors.mjs'

const worker = fileURLToPath(new URL('./managed-files/data_rows.py', import.meta.url))

// Only an explicitly initialized data collection enters this path. Scalar expressions
// and the existing single-line integer operations retain their own grammar.
export function startsDataRows(source) {
    if (/^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*import[ \t]+csv[ \t]*(?:#[^\r\n]*)?\r?\n/.test(source)) return true
    return /^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*[A-Za-z][A-Za-z0-9_]{0,47}[ \t]*=[ \t]*(?:\[|\{|\(|(?:list|dict)[ \t]*\()/.test(source)
}

// Independent chats share a bounded queue in each serving process. Cancelling a
// queued caller releases its slot immediately and never starts a child for it.
const waiting = new Set()
let active = 0

async function acquire(signal) {
    signal?.throwIfAborted()
    if (active < 4) {
        active++
        return
    }
    if (waiting.size >= 64) throw new HarnessError('busy', 'The native row processor is busy.')
    await new Promise((resolve, reject) => {
        function available() {
            signal?.removeEventListener('abort', cancelled)
            resolve()
        }
        function cancelled() {
            waiting.delete(available)
            reject(signal.reason)
        }
        waiting.add(available)
        signal?.addEventListener('abort', cancelled, { once: true })
    })
}

function release() {
    const next = waiting.values().next().value
    if (next) {
        waiting.delete(next)
        next()
    } else active--
}

export async function dataRows(action, code, signal, input) {
    await acquire(signal)
    try {
        return await runWorker(action, code, signal, input)
    } finally {
        release()
    }
}

async function runWorker(action, code, signal, input) {
    signal?.throwIfAborted()
    const completion = Promise.withResolvers()
    const child = execFile(
        '/usr/bin/python3',
        ['-I', '-S', '-B', worker],
        {
            cwd: '/',
            env: { LANG: 'C.UTF-8' },
            timeout: 3000,
            maxBuffer: 64 * 1024,
            signal
        },
        (error, stdout) => completion.resolve({ error, stdout })
    )
    // An abort can settle execFile before the OS child exits. Keep its place
    // occupied through close so a wave of cancellations still respects the cap.
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ action, code, ...input }))
    await closed
    const { error, stdout } = await completion.promise
    signal?.throwIfAborted()
    if (error) throw new HarnessError('workspace_unavailable', 'The native row processor is unavailable.')
    let packet
    try {
        packet = JSON.parse(stdout)
    } catch {
        throw new HarnessError('workspace_unavailable', 'Invalid native row processor response.')
    }
    if (packet.unsupported)
        throw new HarnessError('native_unsupported', 'Choose bounded data rows and the operations in the execute_code schema.')
    return packet
}
