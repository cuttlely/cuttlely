// Validate render.yaml. Structural checks only. Never print env values.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages', 'components', 'package.json'))
const yaml = require('js-yaml')

const DASHBOARD_SECRETS = [
    'WORKOS_API_KEY',
    'WORKOS_CLIENT_ID',
    'WORKOS_REDIRECT_URI',
    'WORKOS_COOKIE_PASSWORD',
    'CUTTLELY_BOOTSTRAP_EMAIL'
]
const GENERATED_SECRETS = ['FLOWISE_SECRETKEY_OVERWRITE']
// Harness models come from in-app credentials (D27, D54). These must not be Blueprint env vars.
const PROVIDER_KEYS_NOT_IN_BLUEPRINT = ['OPENAI_API_KEY', 'XAI_API_KEY']
const DISK_PATH_KEYS = [
    'BLOB_STORAGE_PATH',
    'CUTTLELY_DATA_DIR',
    'CUTTLELY_HERMES_HOME',
    'HERMES_HOME',
    'CUTTLELY_ETL_DIR',
    'DATABASE_PATH',
    'SECRETKEY_PATH',
    'LOG_PATH'
]
const DATABASE_FIELDS = [
    ['DATABASE_HOST', 'host'],
    ['DATABASE_PORT', 'port'],
    ['DATABASE_NAME', 'database'],
    ['DATABASE_USER', 'user'],
    ['DATABASE_PASSWORD', 'password']
]
const SECRET_PATTERNS = [
    { name: 'sk', re: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/ },
    { name: 'xai', re: /(?:^|[^A-Za-z0-9])xai-[A-Za-z0-9_-]{8,}/ },
    { name: 'ghp', re: /ghp_[A-Za-z0-9]{16,}/ },
    { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]{16,}/ },
    { name: 'akia', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'postgres-url', re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i },
    { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ }
]
const SECRET_KEY = /(?:_API_KEY|_SECRET|_PASSWORD|_TOKEN)$/

export function loadBlueprint(text) {
    const doc = yaml.load(text)
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('render.yaml must be a mapping')
    }
    return doc
}

function has(entry, field) {
    return !!entry && Object.prototype.hasOwnProperty.call(entry, field)
}

function underMount(mount, value) {
    if (typeof mount !== 'string' || typeof value !== 'string') return false
    if (!mount.startsWith('/') || !value.startsWith('/')) return false
    const base = mount.length > 1 && mount.endsWith('/') ? mount.slice(0, -1) : mount
    const target = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
    return target === base || target.startsWith(`${base}/`)
}

function literalSecret(value) {
    if (typeof value !== 'string') return ''
    for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0
        if (pattern.re.test(value)) return pattern.name
    }
    return ''
}

export function imageErrors(dockerfileText) {
    const errors = []
    const text = String(dockerfileText || '')
    if (!/^FROM\s+node:24/m.test(text)) errors.push('Dockerfile must use node:24 (node:sqlite)')
    if (!text.includes('setup-hermes.sh')) errors.push('Dockerfile must install the Hermes virtualenv (setup-hermes.sh)')
    if (!text.includes('start-cuttlely.sh')) errors.push('Dockerfile must start Cuttlely and Hermes together (start-cuttlely.sh)')
    if (!text.includes('HOST=0.0.0.0')) errors.push('Dockerfile must set HOST=0.0.0.0 so Render can reach the process')
    return errors
}

export function validateBlueprint(doc, rawText = '') {
    const errors = []
    for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0
        if (rawText && pattern.re.test(rawText)) errors.push(`literal secret pattern in file: ${pattern.name}`)
    }

    const services = Array.isArray(doc.services) ? doc.services : null
    if (!services || services.length === 0) errors.push('services must list at least one service')
    const web = (services || []).find((service) => service && service.type === 'web' && service.runtime === 'docker')
    if (!web) errors.push('services must include a web service with runtime docker')

    const databases = Array.isArray(doc.databases) ? doc.databases : null
    if (!databases || databases.length === 0) errors.push('databases must list a Render Postgres instance')
    const database = databases && databases[0]
    const databaseName = database && database.name

    if (web) {
        if (web.healthCheckPath !== '/api/v1/ping') errors.push('healthCheckPath must be /api/v1/ping')
        if (web.branch !== 'main') errors.push('branch must be main')
        if (web.autoDeployTrigger !== 'commit') errors.push('autoDeployTrigger must be commit (auto-deploy on main)')
        if (has(web, 'autoDeploy') && web.autoDeploy !== true) errors.push('autoDeploy must not turn deploys off')
        const dockerfile = web.dockerfilePath
        if (dockerfile !== './Dockerfile' && dockerfile !== 'Dockerfile') {
            errors.push('dockerfilePath must be the root Dockerfile')
        }
        if (has(web, 'dockerContext') && web.dockerContext !== '.' && web.dockerContext !== './') {
            errors.push('dockerContext must be the repo root')
        }
        if (web.scaling) errors.push('a disk service cannot set scaling')
        if (web.numInstances !== 1) errors.push('numInstances must be 1 because the disk is single-instance')
        if (!web.disk || typeof web.disk !== 'object') errors.push('disk is required')
        else {
            if (!web.disk.name) errors.push('disk.name is required')
            if (typeof web.disk.mountPath !== 'string' || !web.disk.mountPath.startsWith('/')) {
                errors.push('disk.mountPath must be an absolute path')
            }
            if (!Number.isInteger(web.disk.sizeGB) || web.disk.sizeGB < 1) errors.push('disk.sizeGB must be an integer >= 1')
        }
        if (web.plan === 'free') errors.push('plan cannot be free: a disk requires a paid instance')
        if (database && web.region && database.region && web.region !== database.region) {
            errors.push('service region and database region must match so the internal host is used')
        }

        const seen = new Set()
        const envVars = Array.isArray(web.envVars) ? web.envVars : []
        const env = new Map()
        for (const entry of envVars) {
            if (!entry || typeof entry.key !== 'string') {
                errors.push('every env var needs a key')
                continue
            }
            if (seen.has(entry.key)) errors.push(`duplicate env var ${entry.key}`)
            seen.add(entry.key)
            env.set(entry.key, entry)
            if (has(entry, 'value')) {
                const kind = literalSecret(entry.value)
                if (kind) errors.push(`literal secret pattern on ${entry.key}: ${kind}`)
            }
            if (has(entry, 'previewValue')) {
                const kind = literalSecret(entry.previewValue)
                if (kind) errors.push(`literal secret pattern on ${entry.key} previewValue: ${kind}`)
            }
            if (SECRET_KEY.test(entry.key) && (has(entry, 'value') || has(entry, 'previewValue'))) {
                errors.push(`${entry.key} must not carry a literal value`)
            }
        }

        const trustProxy = env.get('TRUST_PROXY')
        if (!trustProxy || String(trustProxy.value) !== '1') errors.push('TRUST_PROXY must be 1 so only the Render proxy hop is trusted')
        if (env.has('PORT')) errors.push('do not set PORT; Render injects it and the start script reads it')
        const host = env.get('HOST')
        if (!host || host.value !== '0.0.0.0') errors.push('HOST must be 0.0.0.0')

        const databaseType = env.get('DATABASE_TYPE')
        if (!databaseType || databaseType.value !== 'postgres') errors.push('DATABASE_TYPE must be postgres')
        if (env.has('DATABASE_URL')) errors.push('Flowise does not read DATABASE_URL; use DATABASE_HOST and the other DATABASE_* fields')

        const mount = web.disk && web.disk.mountPath
        for (const key of DISK_PATH_KEYS) {
            const entry = env.get(key)
            if (!entry || typeof entry.value !== 'string') errors.push(`${key} must be a path on the disk`)
            else if (!underMount(mount, entry.value)) errors.push(`${key} must be on the disk mount`)
        }

        if (!databaseName) errors.push('database name is required')
        else {
            for (const [key, property] of DATABASE_FIELDS) {
                const entry = env.get(key)
                const from = entry && entry.fromDatabase
                if (!from || from.name !== databaseName || from.property !== property) {
                    errors.push(`${key} must use fromDatabase ${databaseName} property ${property}`)
                }
                if (entry && has(entry, 'value')) errors.push(`${key} must not set a literal value`)
            }
            const analyst = env.get('CUTTLELY_POSTGRES_URL')
            if (analyst) {
                if (analyst.fromDatabase) {
                    errors.push('CUTTLELY_POSTGRES_URL must not use fromDatabase. The application database is not the analyst database.')
                }
                if (has(analyst, 'value') || has(analyst, 'previewValue') || has(analyst, 'generateValue')) {
                    errors.push('CUTTLELY_POSTGRES_URL must not set a value in the Blueprint')
                }
            }
            const analystMode = env.get('CUTTLELY_ANALYST')
            if (analystMode) {
                if (analystMode.fromDatabase) errors.push('CUTTLELY_ANALYST must not use fromDatabase.')
                if (has(analystMode, 'value') || has(analystMode, 'previewValue') || has(analystMode, 'generateValue')) {
                    errors.push('CUTTLELY_ANALYST must not set a value in the Blueprint. Set it to auto in the Dashboard.')
                }
            }
        }

        for (const key of PROVIDER_KEYS_NOT_IN_BLUEPRINT) {
            if (env.has(key)) errors.push(`${key} must not be in the Blueprint; harness models use in-app credentials`)
        }
        for (const key of DASHBOARD_SECRETS) {
            const entry = env.get(key)
            if (!entry) errors.push(`${key} must be declared with sync: false`)
            else if (entry.sync !== false || has(entry, 'value') || has(entry, 'generateValue') || has(entry, 'previewValue')) {
                errors.push(`${key} must be sync: false with no value`)
            }
        }
        for (const key of GENERATED_SECRETS) {
            const entry = env.get(key)
            if (!entry) errors.push(`${key} must be generateValue: true`)
            else if (entry.generateValue !== true || has(entry, 'value') || has(entry, 'previewValue')) {
                errors.push(`${key} must be generateValue: true with no value`)
            }
        }
    }

    if (database) {
        if (!database.plan || database.plan === 'free') errors.push('database plan must be a paid plan')
        if (typeof database.postgresMajorVersion !== 'string') {
            errors.push('postgresMajorVersion must be a string (it is immutable after create)')
        }
    }

    return { ok: errors.length === 0, errors }
}

function main() {
    const file = process.argv[2] || path.join(ROOT, 'render.yaml')
    const text = fs.readFileSync(file, 'utf8')
    let doc
    try {
        doc = loadBlueprint(text)
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    }
    const result = validateBlueprint(doc, text)
    const dockerfile = path.join(path.dirname(file), 'Dockerfile')
    if (fs.existsSync(dockerfile)) {
        result.errors.push(...imageErrors(fs.readFileSync(dockerfile, 'utf8')))
    } else {
        result.errors.push('Dockerfile is missing next to render.yaml')
    }
    result.ok = result.errors.length === 0
    if (!result.ok) {
        for (const error of result.errors) console.error(error)
        process.exit(1)
    }
    process.stdout.write(`render blueprint ok (${path.relative(ROOT, file) || file})\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
