// Counts only: descriptor targets can contain private profile names and must never reach logs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHermesStatus } from './hermes-health.mjs'

export async function snapshotDescriptors(pid, procRoot = '/proc') {
    const base = path.join(procRoot, String(pid))
    const [entries, limits] = await Promise.all([fs.readdir(path.join(base, 'fd')), fs.readFile(path.join(base, 'limits'), 'utf8')])
    const match = limits.match(/^Max open files\s+(\d+|unlimited)\s+(\d+|unlimited)/m)
    if (!match) throw new Error('limits unavailable')
    const counts = { total: entries.length, socket: 0, pipe: 0, anon_inode: 0, file: 0, other: 0 }
    // Keep descriptor use bounded even when the runtime is near its nofile limit.
    for (let i = 0; i < entries.length; i += 32) {
        const categories = await Promise.all(
            entries.slice(i, i + 32).map(async (entry) => {
                const fd = path.join(base, 'fd', entry)
                try {
                    const target = await fs.readlink(fd)
                    if (target.startsWith('socket:')) return 'socket'
                    if (target.startsWith('pipe:')) return 'pipe'
                    if (target.startsWith('anon_inode:')) return 'anon_inode'
                    return (await fs.stat(fd)).isFile() ? 'file' : 'other'
                } catch {
                    // Descriptors can close during the snapshot.
                    return 'other'
                }
            })
        )
        for (const category of categories) counts[category]++
    }
    return { ...counts, soft: match[1], hard: match[2] }
}

const unavailableCounts =
    'total=unknown socket=unknown pipe=unknown anon_inode=unknown file=unknown other=unknown soft=unknown hard=unknown'

function diagnosticState({ pid, reason, burst, budget, lifetime, action }) {
    const number = (value) => (/^\d+$/.test(String(value)) ? String(value) : '0')
    const safeReason = /^(exit \d+|health failures \d+|shutdown|no health answer after start)$/.test(String(reason)) ? reason : 'unknown'
    const safeAction = ['restart', 'exit', 'cooldown'].includes(action) ? action : 'unknown'
    return `pid=${number(pid)} reason=${safeReason} burst=${number(burst)} budget=${number(budget)} lifetime=${number(
        lifetime
    )} action=${safeAction}`
}

export async function diagnosticLine(metadata, procRoot = '/proc') {
    const state = diagnosticState(metadata)
    try {
        const snapshot = await snapshotDescriptors(/^\d+$/.test(String(metadata.pid)) ? metadata.pid : 0, procRoot)
        return `Hermes diagnostics ${state} ${Object.entries(snapshot)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')}`
    } catch {
        return `Hermes diagnostics ${state} ${unavailableCounts} diagnostics unavailable`
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [pid, reason, burst, budget, lifetime, action] = process.argv.slice(2)
    const status = readHermesStatus(process.env.CUTTLELY_DATA_DIR)
    const metadata = { pid, reason, burst: burst || status?.restarts, budget, lifetime: lifetime || status?.lifetimeRestarts, action }
    // A disappearing pid or slow proc mount must never hold up recovery.
    const timer = setTimeout(() => {
        console.error(`Hermes diagnostics ${diagnosticState(metadata)} ${unavailableCounts} diagnostics unavailable (snapshot timed out)`)
        process.exit(0)
    }, 1000)
    console.error(await diagnosticLine(metadata))
    clearTimeout(timer)
}
