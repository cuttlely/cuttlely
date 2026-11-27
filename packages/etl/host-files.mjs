// The deployment supplies these files on each member, for example from its image or a private object bucket.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { hermesHome } from '../harness/paths.mjs'

function invalid(reason) {
    throw Object.assign(new Error(reason), { status: 409 })
}

export function verifiedHostFiles(required = []) {
    const file = process.env.CUTTLELY_HOST_FILE_MANIFEST
    const verified = new Map()
    if (file) {
        let entries
        try {
            entries = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
            invalid('The host file manifest is missing or unreadable.')
        }
        if (!Array.isArray(entries)) invalid('The host file manifest must contain an array of files.')
        for (const item of entries) {
            const name = item?.path
            if (typeof name !== 'string' || !name || name.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(item.sha256))
                invalid('The host file manifest contains an invalid path or digest.')
            const target = name.startsWith('runtime/') ? path.join(hermesHome(), name.slice(8)) : name
            if (!path.isAbsolute(target) || verified.has(path.resolve(target)))
                invalid('Each host file needs one unique absolute or runtime-relative path.')
            let fd
            try {
                fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
                if (!fs.fstatSync(fd).isFile()) throw new Error()
                const hash = createHash('sha256')
                const buffer = Buffer.allocUnsafe(65536)
                let count
                while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
                if (hash.digest('hex') !== item.sha256) throw new Error()
            } catch {
                invalid('Restore the deployment-supplied file and its matching manifest entry before startup: ' + name)
            } finally {
                if (fd !== undefined) fs.closeSync(fd)
            }
            verified.set(path.resolve(target), name)
        }
    }
    const names = new Set(verified.values())
    for (const name of required) if (!names.has(name)) invalid('The deployment is missing a required host file declaration: ' + name)
    return verified
}

export function runtimeDependencies(home, prefix = '') {
    const owned = Boolean(prefix && fs.lstatSync(path.join(home, 'harness-compiler'), { throwIfNoEntry: false })?.isFile())
    const targets = [
        'auth.json',
        'vault.key',
        'vault.json.enc',
        'plugins',
        'credentials',
        'pairing',
        'skills',
        'profile.yaml',
        'skin.yaml',
        'plugin.yaml',
        'plugins.json',
        'memories',
        'mem0.json',
        'honcho.json',
        'bot-desktop/browser-profile'
    ]
    if (!owned) targets.push('.env', 'config.yaml', 'SOUL.md', 'harness-roster.json')
    const found = []
    function walk(name) {
        if (owned && name === 'skills/harness-playbooks') return
        const target = path.join(home, name)
        const stat = fs.lstatSync(target, { throwIfNoEntry: false })
        if (!stat) return
        if (stat.isDirectory() && name !== 'SOUL.md') {
            for (const entry of fs.readdirSync(target).sort()) walk(name + '/' + entry)
        } else found.push({ target, name, label: prefix + name, regular: stat.isFile() })
    }
    for (const name of targets) walk(name)
    return found
}
