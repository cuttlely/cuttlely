// Switch database from the Server settings page. A switch always tests the new database first, says what is there
// (empty, or Cuttlely data already), explains how you sign in afterwards, needs RESTART typed to confirm, and keeps
// the previous database so Switch back can put it back. Data is not copied between databases.
import { DATABASE_KEYS, DatabaseSummary, PREVIOUS_DATABASE_FILE, describeDatabase, effectiveValues } from './database-summary'
import { DatabaseTarget, TestDrivers, TestInputError, TestResult, defaultDrivers, testConnection } from './connection'
import { appendHistory } from './history'
import { requestRestart, restartInPlaceAvailable } from './restart'
import { readSettingsFile, readStoredValues, writeSettingsFile } from './store'
import { setupServiceName } from '../identity/setupCode'
import { ServiceDeps, SettingsError, installKind, restartSteps, writeValues } from './service'

export { DATABASE_KEYS, PREVIOUS_DATABASE_FILE, describeDatabase }
export const CONFIRM_WORD = 'RESTART'

type Values = Record<string, string>

function effective(deps: ServiceDeps, file: Values): Values {
    return effectiveValues(deps.env, new Set(deps.state.hostKeys), file)
}

function sameDatabase(a: Values, b: Values): boolean {
    const type = (values: Values) => values.DATABASE_TYPE || 'sqlite'
    if (type(a) !== type(b)) return false
    if (type(a) === 'sqlite') return true
    return ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME'].every((key) => (a[key] || '').toLowerCase() === (b[key] || '').toLowerCase())
}

/** How the owner gets back in after the switch. Null `ok` means there would be no way in. */
export function signInAfter(deps: ServiceDeps, target: DatabaseTarget['kind'] | undefined, values: Values): { ok: boolean; text: string } {
    if (target === 'cuttlely') return { ok: true, text: 'That database has its own accounts. Sign in with one of them after the restart.' }
    const localAdmin = values.CUTTLELY_LOCAL_ADMIN === 'true'
    if (localAdmin) {
        const kind = installKind(deps.env)
        const service = setupServiceName(deps.env)
        const where =
            kind === 'docker'
                ? `the setup link from the server log (docker compose logs ${service} | grep 'Setup code')`
                : kind === 'render'
                ? 'the setup link from the Render log (the line Setup code)'
                : 'the setup link the server prints when it starts, or run pnpm user --email you@example.com'
        return { ok: true, text: `It starts with no accounts. Create the owner again with ${where}.` }
    }
    const email = (values.CUTTLELY_BOOTSTRAP_EMAIL || '').trim()
    const authKit = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI', 'WORKOS_COOKIE_PASSWORD'].every((key) =>
        (values[key] || '').trim()
    )
    if (authKit && email) return { ok: true, text: `It starts with no accounts. The first AuthKit sign-in as ${email} becomes the owner.` }
    return {
        ok: false,
        text: 'It starts with no accounts and nobody could create the owner. Keep password sign-in on, or set the first owner email in Set up AuthKit, first.'
    }
}

function databaseChanges(input: unknown): Values {
    const values = input && typeof input === 'object' ? (input as { values?: unknown }).values : undefined
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TestInputError('Send the new database as values.')
    const raw = values as Record<string, unknown>
    const type = raw.DATABASE_TYPE === 'postgres' ? 'postgres' : raw.DATABASE_TYPE === 'sqlite' ? 'sqlite' : ''
    if (!type) throw new TestInputError('Choose SQLite or Postgres.', [{ key: 'DATABASE_TYPE', message: 'Choose SQLite or Postgres.' }])
    const changes: Values = {}
    for (const key of DATABASE_KEYS) {
        if (key === 'DATABASE_TYPE') changes[key] = type
        else if (type === 'sqlite') changes[key] = ''
        else if (Object.prototype.hasOwnProperty.call(raw, key))
            changes[key] = raw[key] === undefined || raw[key] === null ? '' : String(raw[key])
    }
    return changes
}

function refuseLocked(deps: ServiceDeps): void {
    const locked = DATABASE_KEYS.filter((key) => deps.state.hostKeys.includes(key))
    if (locked.length) {
        throw new SettingsError(
            409,
            'LOCKED',
            `The database is set where Cuttlely is installed (${locked.join(', ')}), so it can only be changed there.`
        )
    }
}

export interface DatabaseCheck {
    test: TestResult
    same: boolean
    signIn: { ok: boolean; text: string }
    canSwitch: boolean
    current: DatabaseSummary
    next: DatabaseSummary
}

/** Tests the new database and says what the switch would mean. Saves nothing. */
export async function checkDatabase(
    deps: ServiceDeps,
    input: unknown,
    drivers: TestDrivers = defaultDrivers(),
    options: { blankKeepsSaved?: boolean } = {}
): Promise<DatabaseCheck> {
    const keepSaved = options.blankKeepsSaved !== false
    refuseLocked(deps)
    const changes = databaseChanges(input)
    const read = readSettingsFile(deps.state.dir, await deps.key())
    const now = effective(deps, read.values)
    const testInput: Values = { ...changes }
    // A blank secret on the page keeps the saved one for the test, the same as saving would not.
    for (const key of ['DATABASE_PASSWORD', 'DATABASE_SSL_KEY_BASE64'])
        if (keepSaved && testInput[key] === '' && changes.DATABASE_TYPE === 'postgres') delete testInput[key]
    const test = await testConnection(deps, { kind: 'database', values: testInput }, drivers)
    const nextFile = { ...read.values }
    for (const [key, value] of Object.entries(changes)) {
        if (
            value === '' &&
            !(keepSaved && changes.DATABASE_TYPE === 'postgres' && (key === 'DATABASE_PASSWORD' || key === 'DATABASE_SSL_KEY_BASE64'))
        )
            delete nextFile[key]
        else if (value !== '') nextFile[key] = value
    }
    const next = effective(deps, nextFile)
    const same = sameDatabase(now, next)
    const signIn = signInAfter(deps, test.target?.kind, next)
    return {
        test,
        same,
        signIn,
        canSwitch: test.ok && !same && signIn.ok,
        current: describeDatabase(now),
        next: describeDatabase(next)
    }
}

function requireConfirm(input: unknown): void {
    const confirm = input && typeof input === 'object' ? (input as { confirm?: unknown }).confirm : undefined
    if (confirm !== CONFIRM_WORD)
        throw new TestInputError(`Type ${CONFIRM_WORD} to confirm.`, [{ key: 'confirm', message: `Type ${CONFIRM_WORD} to confirm.` }])
}

/** Keeps the database settings as they are now, so Switch back can put them back. Secrets stay encrypted. */
function keepPrevious(deps: ServiceDeps, key: string, by: string): void {
    const stored = readStoredValues(deps.state.dir)
    const preserve = Object.fromEntries(Object.entries(stored).filter(([name]) => DATABASE_KEYS.includes(name)))
    writeSettingsFile(deps.state.dir, {}, { key, by, file: PREVIOUS_DATABASE_FILE, preserve })
}

async function finish(deps: ServiceDeps, by: string, note: string): Promise<{ restarting: boolean; steps: string[] }> {
    if (!restartInPlaceAvailable(deps.env)) return { restarting: false, steps: restartSteps(deps.env) }
    appendHistory(deps.state.dir, { kind: 'restart', by, note, outcome: 'ok' })
    return { restarting: requestRestart({ env: deps.env }), steps: [] }
}

/** Switches to the new database after a passing test and RESTART typed, then restarts when it can. */
export async function switchDatabase(
    deps: ServiceDeps,
    input: unknown,
    by: string,
    drivers: TestDrivers = defaultDrivers()
): Promise<DatabaseCheck & { switched: boolean; restarting: boolean; steps: string[] }> {
    requireConfirm(input)
    const check = await checkDatabase(deps, input, drivers)
    if (!check.canSwitch) {
        const message = check.same
            ? 'That is the database Cuttlely already uses.'
            : !check.test.ok
            ? 'The new database did not pass the test, so nothing changed.'
            : check.signIn.text
        throw new SettingsError(409, 'CANNOT_SWITCH', message)
    }
    const key = await deps.key()
    keepPrevious(deps, key, by)
    const changes = databaseChanges(input)
    for (const name of ['DATABASE_PASSWORD', 'DATABASE_SSL_KEY_BASE64'])
        if (changes[name] === '' && changes.DATABASE_TYPE === 'postgres') delete changes[name]
    const what = check.test.target?.kind === 'cuttlely' ? 'Cuttlely data already there' : 'empty; Cuttlely sets it up at the next start'
    await writeValues(deps, changes, by, 'save', `Switched the database to ${check.next.label} (${what}).`)
    const restart = await finish(deps, by, `Restarted to switch the database to ${check.next.label}.`)
    return { ...check, switched: true, ...restart }
}

/** Switch back: tests the previous database, then puts it back (and keeps the current one as the new previous). */
export async function restorePreviousDatabase(
    deps: ServiceDeps,
    input: unknown,
    by: string,
    drivers: TestDrivers = defaultDrivers()
): Promise<DatabaseCheck & { switched: boolean; restarting: boolean; steps: string[] }> {
    requireConfirm(input)
    refuseLocked(deps)
    const key = await deps.key()
    const previous = readSettingsFile(deps.state.dir, key, PREVIOUS_DATABASE_FILE)
    if (!previous.exists) throw new SettingsError(404, 'NO_PREVIOUS', 'There is no previous database to switch back to.')
    if (previous.unreadable.length)
        throw new SettingsError(409, 'UNREADABLE', 'The previous database password could not be read on this server.')
    const values: Values = { DATABASE_TYPE: previous.values.DATABASE_TYPE || 'sqlite' }
    for (const name of DATABASE_KEYS) if (name !== 'DATABASE_TYPE') values[name] = previous.values[name] ?? ''
    const check = await checkDatabase(deps, { values }, drivers, { blankKeepsSaved: false })
    if (!check.canSwitch) {
        throw new SettingsError(
            409,
            'CANNOT_SWITCH',
            check.test.ok ? check.signIn.text : 'The previous database did not pass the test, so nothing changed.'
        )
    }
    keepPrevious(deps, key, by)
    await writeValues(deps, values, by, 'restore', `Switched back to the previous database, ${check.next.label}.`)
    const restart = await finish(deps, by, `Restarted to switch back to ${check.next.label}.`)
    return { ...check, switched: true, ...restart }
}
