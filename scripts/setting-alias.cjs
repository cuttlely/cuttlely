// One reader for product-named settings and the existing names.
// Empty string is unset, the same check the encryption key reader already uses.
// A value of only spaces stays set: callers that trim do it themselves.
// CommonJS so the server test runner can load it. ESM callers import this file.

const SECRET_KEY_ALIAS = 'CUTTLELY_SECRETKEY_OVERWRITE'
const SECRET_KEY_EXISTING = 'FLOWISE_SECRETKEY_OVERWRITE'
const FILE_SIZE_ALIAS = 'CUTTLELY_FILE_SIZE_LIMIT'
const FILE_SIZE_EXISTING = 'FLOWISE_FILE_SIZE_LIMIT'
const TELEMETRY_ALIAS = 'DISABLE_CUTTLELY_TELEMETRY'
const TELEMETRY_EXISTING = 'DISABLE_FLOWISE_TELEMETRY'

// The two names of one setting. The first name is the one read first.
const ALIAS_PAIRS = [
    [SECRET_KEY_ALIAS, SECRET_KEY_EXISTING],
    [FILE_SIZE_ALIAS, FILE_SIZE_EXISTING],
    [TELEMETRY_ALIAS, TELEMETRY_EXISTING]
]

const ENCRYPTION_KEY_CONFLICT =
    'CUTTLELY_SECRETKEY_OVERWRITE and FLOWISE_SECRETKEY_OVERWRITE are both set to different values. Cuttlely will not start. Unset one of them so stored credentials stay readable.'

function isSet(value) {
    return value !== undefined && value !== ''
}

/** Product-named variable first, then the existing name. */
function readSettingAlias(env, alias, existing) {
    const source = env ?? {}
    if (isSet(source[alias])) return source[alias]
    if (isSet(source[existing])) return source[existing]
    return undefined
}

function aliasNames(key) {
    for (const pair of ALIAS_PAIRS) {
        if (pair.includes(key)) return pair.filter((name) => name !== key)
    }
    return []
}

/** True when another name of the same setting is set and is not a script-filled default. */
function partnerIsSet(env, key, ignored = []) {
    const skip = ignored instanceof Set ? ignored : new Set(ignored || [])
    const source = env ?? {}
    return aliasNames(key).some((other) => !skip.has(other) && isSet(source[other]))
}

function encryptionKeyConflict(env) {
    const source = env ?? {}
    const next = source[SECRET_KEY_ALIAS]
    const prev = source[SECRET_KEY_EXISTING]
    if (isSet(next) && isSet(prev) && next !== prev) return ENCRYPTION_KEY_CONFLICT
    return undefined
}

/** The overwrite value, or undefined when neither name is set. Throws when the two values differ. */
function encryptionKeyOverwrite(env) {
    const conflict = encryptionKeyConflict(env)
    if (conflict) {
        const error = new Error(conflict)
        error.code = 'ENCRYPTION_KEY_CONFLICT'
        throw error
    }
    return readSettingAlias(env, SECRET_KEY_ALIAS, SECRET_KEY_EXISTING)
}

function fileSizeLimit(env, fallback = '50mb') {
    return readSettingAlias(env, FILE_SIZE_ALIAS, FILE_SIZE_EXISTING) || fallback
}

/** The string true turns usage events off. Any other set value leaves them on. */
function telemetryDisabled(env) {
    return readSettingAlias(env, TELEMETRY_ALIAS, TELEMETRY_EXISTING) === 'true'
}

module.exports = {
    SECRET_KEY_ALIAS,
    SECRET_KEY_EXISTING,
    FILE_SIZE_ALIAS,
    FILE_SIZE_EXISTING,
    TELEMETRY_ALIAS,
    TELEMETRY_EXISTING,
    ALIAS_PAIRS,
    ENCRYPTION_KEY_CONFLICT,
    isSet,
    readSettingAlias,
    aliasNames,
    partnerIsSet,
    encryptionKeyConflict,
    encryptionKeyOverwrite,
    fileSizeLimit,
    telemetryDisabled
}
