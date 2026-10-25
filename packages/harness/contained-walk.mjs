import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, hermesHome } from './paths.mjs'

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW

function profilesRoot() {
    return path.join(hermesHome(), 'profiles')
}

function workspacesRoot() {
    return path.join(dataRoot(), 'workspaces')
}

function containmentRoot(file) {
    const resolved = path.resolve(file)
    for (const root of [profilesRoot(), workspacesRoot()]) {
        const base = path.resolve(root)
        if (resolved === base || resolved.startsWith(base + path.sep)) return base
    }
    return null
}

// Every component from the filesystem root down to dir. A link above the hermes home is in this list.
export function ancestorPaths(dir) {
    const root = containmentRoot(dir)
    if (!root) return null
    const resolved = path.resolve(dir)
    const relToRoot = path.relative(root, resolved)
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null
    const fsRoot = path.parse(resolved).root
    const rel = path.relative(fsRoot, resolved)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    const paths = [fsRoot]
    let cursor = fsRoot
    for (const part of rel.split(path.sep)) {
        if (!part || part === '.' || part === '..') return null
        cursor = path.join(cursor, part)
        paths.push(cursor)
    }
    return paths
}

function closeFds(fds) {
    for (let i = fds.length - 1; i >= 0; i -= 1) {
        try {
            fs.closeSync(fds[i])
        } catch {
            // Already closed.
        }
    }
}

function fdPath(dirFd, name) {
    if (process.platform === 'linux') return `/proc/self/fd/${dirFd}/${name}`
    return null
}

// Opens dir from the filesystem root. A missing component or a link returns null and the link stays put.
function openDirQuiet(dir) {
    const paths = ancestorPaths(dir)
    if (!paths) return null
    const fds = []
    try {
        let dirFd
        try {
            dirFd = fs.openSync(paths[0], DIR_FLAGS)
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'EEXIST') return null
            throw error
        }
        fds.push(dirFd)
        for (let i = 1; i < paths.length; i += 1) {
            const part = path.basename(paths[i])
            if (!part || part === '.' || part === '..') {
                closeFds(fds)
                return null
            }
            const via = fdPath(dirFd, part) || paths[i]
            let next
            try {
                next = fs.openSync(via, DIR_FLAGS)
            } catch (error) {
                closeFds(fds)
                if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'EEXIST' || error?.code === 'ENOTDIR')
                    return null
                throw error
            }
            fds.push(next)
            dirFd = next
            if (fs.fstatSync(dirFd).isSymbolicLink()) {
                closeFds(fds)
                return null
            }
        }
        return { fd: dirFd, fds }
    } catch (error) {
        closeFds(fds)
        throw error
    }
}

export function listDirNoFollow(dir) {
    const opened = openDirQuiet(dir)
    if (!opened) return null
    try {
        if (process.platform === 'linux') return fs.readdirSync(`/proc/self/fd/${opened.fd}`)
        return fs.readdirSync(dir)
    } finally {
        closeFds(opened.fds)
    }
}

export function readFileNoFollow(file) {
    const parent = path.dirname(path.resolve(file))
    const opened = openDirQuiet(parent)
    if (!opened) return null
    const fds = opened.fds
    try {
        const base = path.basename(file)
        if (!base || base === '.' || base === '..') return null
        const via = fdPath(opened.fd, base) || file
        let fileFd
        try {
            fileFd = fs.openSync(via, fs.constants.O_RDONLY | NOFOLLOW)
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'EEXIST') return null
            throw error
        }
        fds.push(fileFd)
        if (!fs.fstatSync(fileFd).isFile()) return null
        return fs.readFileSync(fileFd, 'utf8')
    } finally {
        closeFds(fds)
    }
}
