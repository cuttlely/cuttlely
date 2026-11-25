import fs from 'fs'

/** Host-only operator files must be regular files owned by the process with no group or other permissions. */
export function readPrivateFile(file: string): string {
    const link = fs.lstatSync(file)
    if (!link.isFile() || link.isSymbolicLink()) throw new Error('unsafe binding')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > 4096 || stat.ino !== link.ino || stat.dev !== link.dev) throw new Error('unsafe binding')
        if (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.geteuid?.()))
            throw new Error('unsafe permissions')
        return fs.readFileSync(fd, 'utf8')
    } finally {
        fs.closeSync(fd)
    }
}
