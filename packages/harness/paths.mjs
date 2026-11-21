import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// This file lives in packages/harness, so the checkout is two directories up.
export function repoRoot() {
    return path.resolve(here, '..', '..')
}

export function dataRoot() {
    return process.env.CUTTLELY_DATA_DIR || path.join(repoRoot(), '.cuttlely')
}

export function harnessStoreDir() {
    return path.join(dataRoot(), 'harnesses')
}

export function hermesHome() {
    return process.env.CUTTLELY_HERMES_HOME || path.join(dataRoot(), 'hermes')
}

export function hermesBaseUrl() {
    return process.env.HERMES_API_URL || 'http://127.0.0.1:8642'
}

// Saved names are case-sensitive; the runtime accepts lowercase ids of at most 64 characters.
export function profileHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}

export function harnessProfileId(name) {
    const original = String(name || '')
    const lower = original.toLowerCase()
    if (original === lower) return original
    let stem = lower.slice(0, 64 - 1 - 8)
    while (stem.endsWith('-') || stem.endsWith('_')) stem = stem.slice(0, -1)
    return `${stem}-${profileHash(original)}`
}

// Callers pass a runtime id. Path lookup has no migration side effects.
export function profileDir(id) {
    return path.join(hermesHome(), 'profiles', id)
}

export function vendoredHermesDir() {
    return path.join(repoRoot(), 'hermes')
}
