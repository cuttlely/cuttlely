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

export function profileDir(name) {
    return path.join(hermesHome(), 'profiles', name)
}

export function vendoredHermesDir() {
    return path.join(repoRoot(), 'hermes')
}
