// Installation-side provenance. Never take the reference hashes from the mutable runtime home.
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export function installedSkillCatalog() {
    if (process.env.HERMES_BUNDLED_SKILLS?.trim()) return {}
    try {
        return JSON.parse(fs.readFileSync(new URL('./bundled-skill-files.generated.json', import.meta.url), 'utf8'))
    } catch {
        return {}
    }
}

export function matchesBundledSkill(file, entry) {
    if (!Array.isArray(entry)) return false
    const [size, digest] = entry
    let fd
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size !== size) return false
        return createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === digest
    } catch {
        return false
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}
