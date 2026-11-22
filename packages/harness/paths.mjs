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

// The runtime serves a named profile only when its folder is a lowercase id (hermes_constants.PROFILE_ID_RE), and a
// /p/<profile>/ prefix must name it exactly. Harness names may use capitals, so every profile folder and runtime
// prefix uses the lowercase id. Specialist and draft names are lowercase already.
export function hermesProfileId(name) {
    return typeof name === 'string' ? name.toLowerCase() : name
}

export function profileDir(name) {
    return path.join(hermesHome(), 'profiles', hermesProfileId(name))
}

export function vendoredHermesDir() {
    return path.join(repoRoot(), 'hermes')
}
