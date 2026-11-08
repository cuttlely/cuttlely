// Host-owned authority, deliberately separate from server.json and all settings snapshots.
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { appendHistory } from '../settings/history'
import { withNamedLockSync } from '../settings/lock'
import { settingsDir } from '../settings/store'
import logger from '../utils/logger'

type Env = Record<string, string | undefined>
export const OPERATOR_BINDING_FILE = 'instance-operator.json'
export interface OperatorIdentity {
    userId: string
    database: string
}

export function validOperatorIdentity(value: OperatorIdentity): boolean {
    return (
        typeof value.userId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.userId) &&
        typeof value.database === 'string' &&
        /^[a-f0-9]{64}$/.test(value.database)
    )
}

let lastNotice = ''
/** Host log only: never include file bytes, credentials, paths, emails or fingerprints. */
export function operatorNotice(reason: string): void {
    if (reason === lastNotice) return
    lastNotice = reason
    if (reason) logger.warn(`[instance operator] ${reason}`)
}

function readPrivateFile(file: string): string {
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

export function readOperatorBinding(env: Env): OperatorIdentity | null {
    try {
        const value = JSON.parse(readPrivateFile(path.join(settingsDir(env), OPERATOR_BINDING_FILE)))
        if (
            !value ||
            Object.keys(value).sort().join(',') !== 'createdAt,database,userId,version' ||
            value.version !== 1 ||
            !validOperatorIdentity(value) ||
            typeof value.createdAt !== 'string' ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) ||
            !Number.isFinite(Date.parse(value.createdAt)) ||
            new Date(value.createdAt).toISOString() !== value.createdAt
        )
            throw new Error('invalid binding')
        return { userId: value.userId, database: value.database }
    } catch {
        operatorNotice(
            'Host binding missing or invalid. Browser service administration is closed. Run pnpm user --email <owner-email> --bind-operator on the host to recover.'
        )
        return null
    }
}

function atomicBinding(dir: string, raw: string): void {
    const temp = path.join(dir, `.${OPERATOR_BINDING_FILE}.${randomUUID()}.tmp`)
    try {
        const fd = fs.openSync(temp, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, raw)
            if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        fs.renameSync(temp, path.join(dir, OPERATOR_BINDING_FILE))
    } finally {
        fs.rmSync(temp, { force: true })
    }
}

/** Called only by the host user command after a successful credential operation or explicit bind. */
export function writeOperatorBinding(identity: OperatorIdentity, env: Env): void {
    if (!validOperatorIdentity(identity)) throw new Error('invalid operator identity')
    const dir = settingsDir(env)
    withNamedLockSync(dir, '.operator-binding.lock', () => {
        const file = path.join(dir, OPERATOR_BINDING_FILE)
        // A corrupt JSON file can be replaced, but never follow a symlink or read an unsafe file.
        const previous = fs.existsSync(file) ? readPrivateFile(file) : null
        atomicBinding(dir, JSON.stringify({ version: 1, ...identity, createdAt: new Date().toISOString() }) + '\n')
        try {
            appendHistory(dir, {
                kind: 'save',
                by: 'command line',
                event: 'instance_operator_binding',
                note:
                    previous === null ? 'Host operator binding created' : 'Host operator binding replaced; previous file authority revoked',
                outcome: 'ok'
            })
        } catch (error) {
            if (previous === null) fs.rmSync(file)
            else atomicBinding(dir, previous)
            throw error
        }
        logger.info(
            '[instance operator] Host binding saved; previous file authority revoked. Host environment override or none still takes precedence.'
        )
        lastNotice = ''
    })
}
