// Host-owned authority, deliberately separate from server.json and all settings snapshots.
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { appendHistory } from '../settings/history'
import { withNamedLockSync } from '../settings/lock'
import { settingsDir } from '../settings/store'
import logger from '../utils/logger'

type Env = Record<string, string | undefined>
export const OPERATOR_BINDING_FILE = 'instance-operator.json'
export const OPERATOR_BINDING_LOCK = '.operator-binding.lock'
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

export function readPrivateOperatorFile(file: string): string {
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

export type ManagedOperator =
    | { state: 'Unclaimed'; generation: string; identity: null }
    | { state: 'Active'; generation: string; identity: OperatorIdentity; source: string }
    | { state: 'Disabled' | 'RecoveryRequired'; generation: string; identity: null }

/** Decode only private validated files. Version 1 is the actual host CLI's historical binding. */
export function managedOperator(env: Env): ManagedOperator {
    let raw: string | null
    try {
        raw = operatorBindingSnapshot(env)
    } catch {
        return { state: 'RecoveryRequired', generation: 'unsafe', identity: null }
    }
    if (raw === null) return { state: 'Unclaimed', generation: 'unclaimed', identity: null }
    const generation = createHash('sha256').update(raw).digest('hex')
    try {
        const value = JSON.parse(raw)
        if (!value || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt)
            throw new Error('invalid')
        if (
            value.version === 1 &&
            Object.keys(value).sort().join(',') === 'createdAt,database,userId,version' &&
            validOperatorIdentity(value)
        )
            return { state: 'Active', generation, identity: { userId: value.userId, database: value.database }, source: 'host CLI' }
        const keys =
            value.state === 'Active'
                ? 'audit,createdAt,database,generation,source,state,userId,version'
                : 'audit,createdAt,generation,source,state,version'
        if (
            value.version !== 2 ||
            Object.keys(value).sort().join(',') !== keys ||
            !/^[a-f0-9-]{36}$/.test(value.generation) ||
            !['host CLI', 'admin panel'].includes(value.source) ||
            !value.audit ||
            typeof value.audit.eventId !== 'string' ||
            typeof value.audit.actorId !== 'string' ||
            !['Active', 'Disabled'].includes(value.state)
        )
            throw new Error('invalid')
        if (value.state === 'Disabled') return { state: 'Disabled', generation, identity: null }
        if (!validOperatorIdentity(value)) throw new Error('invalid')
        return { state: 'Active', generation, identity: { userId: value.userId, database: value.database }, source: value.source }
    } catch {
        return { state: 'RecoveryRequired', generation, identity: null }
    }
}

export function readOperatorBinding(env: Env): OperatorIdentity | null {
    const managed = managedOperator(env)
    if (managed.state === 'Active') return managed.identity
    operatorNotice(
        'Host binding unavailable. Browser service administration is closed. Use the explicit panel host-proof flow or host user CLI recovery.'
    )
    return null
}

function atomicBinding(dir: string, raw: string, create = false, name = OPERATOR_BINDING_FILE): void {
    const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`)
    try {
        const fd = fs.openSync(temp, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, raw)
            if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        if (create) fs.linkSync(temp, path.join(dir, name))
        else fs.renameSync(temp, path.join(dir, name))
    } finally {
        fs.rmSync(temp, { force: true })
    }
}

/** Host recovery and the panel share the same lock and generation transitions. */
export function writeOperatorBinding(identity: OperatorIdentity, env: Env): void {
    if (!validOperatorIdentity(identity)) throw new Error('invalid operator identity')
    withNamedLockSync(settingsDir(env), OPERATOR_BINDING_LOCK, () => {
        publishOperator(identity, operatorBindingSnapshot(env), env, 'command line', 'host_recovery', 'host CLI')
        logger.info(
            '[instance operator] Host binding saved; previous file authority revoked. Host environment override or none still takes precedence.'
        )
    })
}

/** The caller must hold OPERATOR_BINDING_LOCK. Null means missing; unsafe files throw. */
export function operatorBindingSnapshot(env: Env): string | null {
    try {
        return readPrivateOperatorFile(path.join(settingsDir(env), OPERATOR_BINDING_FILE))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

/** CAS under the shared lock. Embedded audit is durable with authority; history is its projection. */
export function publishOperator(
    identity: OperatorIdentity | null,
    previous: string | null,
    env: Env,
    actorId: string,
    action: string,
    source = 'admin panel'
): void {
    if (operatorBindingSnapshot(env) !== previous) throw new Error('operator binding changed')
    const dir = settingsDir(env)
    const file = path.join(dir, OPERATOR_BINDING_FILE)
    const before = managedOperator(env)
    const audit = {
        eventId: randomUUID(),
        actorId,
        targetId: identity?.userId ?? null,
        from: before.state,
        to: identity ? 'Active' : 'Disabled',
        purpose: action,
        source
    }
    const value = { version: 2, state: audit.to, generation: randomUUID(), source, ...identity, createdAt: new Date().toISOString(), audit }
    if (identity && !validOperatorIdentity(identity)) throw new Error('invalid operator identity')
    atomicBinding(dir, JSON.stringify(value) + '\n', previous === null)
    try {
        appendHistory(dir, {
            kind: 'save',
            by: source === 'host CLI' ? 'command line' : 'admin panel',
            actorId,
            event: source === 'host CLI' ? 'instance_operator_binding' : 'instance_operator_' + action,
            note: 'Operator authority ' + audit.from + ' to ' + audit.to + '; purpose ' + action + '; event ' + audit.eventId,
            changes: [{ key: 'operator_user_id', from: before.identity?.userId ?? '', to: identity?.userId ?? '' }],
            outcome: 'ok'
        })
    } catch (error) {
        if (previous === null) fs.unlinkSync(file)
        else atomicBinding(dir, previous)
        throw error
    }
    lastNotice = ''
}

/** Stable host-side installation identity, independent of the replaceable application database. Lock required. */
export function operatorInstallation(env: Env): string {
    const file = path.join(settingsDir(env), 'operator-installation.json')
    try {
        const value = JSON.parse(readPrivateOperatorFile(file))
        if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('invalid installation')
        return value.id
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const id = randomUUID()
        const fd = fs.openSync(file, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, JSON.stringify({ id }))
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        return id
    }
}

/** Plaintext proof is emitted exactly once by the rate-limited claim issuer, to the host logger only. */
export function logOperatorClaimCode(code: string): void {
    logger.info('[instance operator] Panel designation proof (expires in 5 minutes; use in the requesting session): ' + code)
}

/** Root shells must invoke recovery as the data owner, matching the running server's uid. */
export function operatorRecoveryUserError(env: Env): string | null {
    if (process.platform === 'win32' || process.geteuid?.() !== 0) return null
    let dir = path.dirname(settingsDir(env))
    while (!fs.existsSync(dir)) {
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    if (fs.statSync(dir).uid === 0) return null
    return 'Refusing root recovery: the data directory belongs to another user. Run as its owner. For the Render node user: setpriv --reuid=node --regid=node --init-groups -- pnpm user --email <owner-email> --bind-operator (omit --bind-operator for password recovery).'
}

/** Private, durable challenge/rate state. Caller holds the authority lock. */
export function writeOperatorProofState(env: Env, value: string): void {
    atomicBinding(settingsDir(env), value, false, 'operator-claim.json')
}
