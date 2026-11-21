import fs from 'node:fs'
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
    const id = hermesProfileId(name)
    const dir = path.join(hermesHome(), 'profiles', id)
    if (id !== name) adoptMixedCaseProfileDir(path.join(hermesHome(), 'profiles', name), dir)
    return dir
}

// A harness saved with capitals compiled into profiles/<Name> before 1.7.13, a folder the runtime never served.
// Move it to the lowercase id once, so its sessions and memory stay with the harness. A link, or a lowercase folder
// that is already there (the same folder on a case-insensitive disk), is left alone.
function adoptMixedCaseProfileDir(legacy, dir) {
    try {
        if (!fs.lstatSync(legacy).isDirectory()) return
    } catch {
        return
    }
    try {
        fs.lstatSync(dir)
        return
    } catch (error) {
        if (error?.code !== 'ENOENT') return
    }
    try {
        fs.renameSync(legacy, dir)
    } catch {
        // Left for the next call. The compile still writes the lowercase folder.
    }
}

export function vendoredHermesDir() {
    return path.join(repoRoot(), 'hermes')
}
