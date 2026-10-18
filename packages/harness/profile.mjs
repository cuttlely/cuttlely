import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { isFlowiseMcpBinding } from './bridge.mjs'
import { CHIEF_MODEL_REQUIRED, HarnessError } from './errors.mjs'
import { stableStringify } from './flow-graph.mjs'
import { credentialStamp } from './credential-store.mjs'
import { forgetProfileToken, gatewayListenPort, gatewayOrigin, gatewayUrl, registerProfileToken } from './gateway.mjs'
import { endLiveTry, noteLiveTry } from './try-live.mjs'
import { dataRoot, repoRoot, hermesHome, profileDir } from './paths.mjs'
import { ANALYST_RULES_MAX_CHARS, ROUTING_SUMMARY_CHARS, joinedAnalystRules, routingSummaryText } from './store.mjs'
import { SQL_TOOL_REFUSED, refusedRawServer } from './sql-tools.mjs'
import { parseRelationSelection } from './runtime/analyst-relations.mjs'

const require = createRequire(import.meta.url)

const CHIEF_TOOLSETS = ['delegation', 'memory', 'session_search']
const BLOCKED_UNLESS_ENABLED = ['terminal', 'browser', 'code_execution', 'file', 'web']
// Read-only Hermes skills (skills_list, skill_view; a Cuttlely patch in hermes/toolsets.py). Playbooks live in
// the profile's skills folder under PLAYBOOK_DIR, which Cuttlely owns and rewrites on every compile.
export const PLAYBOOK_TOOLSET = 'skills_read'
export const PLAYBOOK_DIR = 'harness-playbooks'
export const SPECIALIST_PLAYBOOKS =
    'Your playbooks are listed under skills. Before you answer, load each playbook whose description fits the question with skill_view, and follow it.'
const SPECIALIST_STALE_SECONDS = 45
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PROFILE_MAX = 64
const PROFILE_HASH = 8

// Provider keys are never written into a profile. Tool credentials still cannot smuggle one in under these names.
const MODEL_ENV_KEYS = [
    ['OPENAI', '_API_KEY'].join(''),
    ['XAI', '_API_KEY'].join(''),
    ['ANTHROPIC', '_API_KEY'].join(''),
    ['OPENROUTER', '_API_KEY'].join(''),
    ['GROQ', '_API_KEY'].join(''),
    ['GOOGLE', '_API_KEY'].join(''),
    ['DEEPSEEK', '_API_KEY'].join(''),
    ['HERMES', '_MODEL_KEY'].join(''),
    ['MINIMAX', '_API_KEY'].join('')
]

const PLACEHOLDER_VALUES = new Set(['', 'changeme', 'change-me', 'your-api-key', 'replace-me', 'sk-xxx'])

function yamlQuote(value) {
    return JSON.stringify(String(value))
}

function yamlToken(value) {
    const text = String(value)
    if (!/^[A-Za-z0-9._-]+$/.test(text)) {
        throw new HarnessError('bad_model', `Model value "${text}" is not a plain token.`)
    }
    return text
}

function credentialIdOf(value) {
    const credentialId = typeof value?.credentialId === 'string' ? value.credentialId.trim() : ''
    if (!credentialId || credentialId.length > 80 || /\s/.test(credentialId)) return ''
    return credentialId
}

export function modelChoice(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.nodeName) {
        const credential = typeof value.credential === 'string' ? value.credential.trim() : ''
        const credentialId = credentialIdOf(value)
        return {
            nodeId: value.nodeId,
            nodeName: value.nodeName,
            label: value.label,
            category: value.category,
            inputs: value.inputs || {},
            ...(value.upstream ? { upstream: value.upstream } : {}),
            ...(value.outputs ? { outputs: value.outputs } : {}),
            ...(value.description ? { description: value.description } : {}),
            ...(credential ? { credential } : {}),
            ...(credentialId ? { credentialId } : {})
        }
    }
    if (!value.provider || !value.model) return null
    const credentialId = credentialIdOf(value)
    return {
        provider: String(value.provider),
        model: String(value.model),
        ...(credentialId ? { credentialId } : {})
    }
}

function describedModel(model) {
    if (!model) return ''
    const name = model.inputs?.modelName || model.label || model.model
    return name ? String(name) : ''
}

// A char-class replace can leave a long run of dashes. An end-anchored dash quantifier is polynomial on that run, so this walks the ends.
function trimDashEnds(value) {
    let start = 0
    let end = value.length
    while (start < end && value.charCodeAt(start) === 45) start += 1
    while (end > start && value.charCodeAt(end - 1) === 45) end -= 1
    return value.slice(start, end)
}

function trimLeadingDashes(value) {
    let start = 0
    while (start < value.length && value.charCodeAt(start) === 45) start += 1
    return value.slice(start)
}

function profileHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, PROFILE_HASH)
}

// A try id is "try" plus 16 hex characters, so a long specialist slug no longer fits in 64.
// Ids that already fit stay as they are. A fitted id keeps a hash of the full slug so two long names cannot collide.
// When the harness name itself leaves no room, the directory is tryx plus 16 hex. That is not a savable harness
// name and it has no "--", so it cannot equal some other harness's specialist profile.
function fittedProfileId(harness, slug) {
    const hash = crypto.createHash('sha256').update(`${harness}\0${slug}`).digest('hex').slice(0, 16)
    return `tryx${hash}`
}

function fitSpecialistProfile(harness, slug) {
    const suffix = `-${profileHash(slug)}`
    const slugRoom = PROFILE_MAX - harness.length - '--'.length - suffix.length
    if (slugRoom < 1) {
        const fitted = fittedProfileId(harness, slug)
        if (!PROFILE_ID_RE.test(fitted)) {
            throw new HarnessError('bad_name', `Specialist "${slug}" cannot get its own model profile.`)
        }
        return fitted
    }
    const slugKept = trimDashEnds(slug.slice(0, slugRoom))
    const fitted = slugKept ? `${harness}--${slugKept}${suffix}` : `${harness}--${profileHash(slug)}`
    if (fitted.length > PROFILE_MAX || !PROFILE_ID_RE.test(fitted)) {
        throw new HarnessError('bad_name', `Specialist "${slug}" cannot get its own model profile.`)
    }
    return fitted
}

export function specialistProfileName(harnessName, specialistName) {
    const harness = String(harnessName || '').toLowerCase()
    const slug = trimDashEnds(
        String(specialistName || '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
    )
    const profile = `${harness}--${slug}`
    if (profile.length <= PROFILE_MAX && PROFILE_ID_RE.test(profile)) return profile
    return fitSpecialistProfile(harness, slug || String(specialistName || 'specialist'))
}

function serverNameFor(specialist) {
    return specialist.name
}

export function hermesToolsetsFor(specialist) {
    // Hermes treats an MCP server name as the toolset. A "mcp-" prefix is an unknown
    // toolset, so the first turn starts before that server's tools exist.
    // Add that name only when the bridge is on. A specialist named "browser" must not
    // drop the built-in browser toolset just because the bridge is off.
    const sets = []
    if (usesBridge(specialist)) sets.push(serverNameFor(specialist))
    for (const mcp of specialist.mcpServers || []) {
        if (isFlowiseMcpBinding(mcp)) continue
        const config = parseServerConfig(mcp)
        if (refusedRawServer(mcp, config)) continue
        if (!config || rawServerProblem(config)) continue
        const name = sanitizeServerName(mcp.serverName || config?.name || `${specialist.name}-mcp`)
        if (!sets.includes(name)) sets.push(name)
    }
    if (specialist.shell) sets.push('terminal')
    if (specialist.browser) sets.push('browser')
    if (specialist.codeExecution) sets.push('code_execution')
    if (specialist.fileAccess) sets.push('file')
    if ((specialist.playbooks || []).length) sets.push(PLAYBOOK_TOOLSET)
    return sets
}

export function needsAgentLoop(specialist) {
    return Boolean(
        specialist?.shell ||
            specialist?.browser ||
            specialist?.codeExecution ||
            specialist?.fileAccess ||
            (specialist?.playbooks || []).length ||
            (specialist?.mcpServers || []).length
    )
}

export function specialistWorkspace(profileName) {
    return path.join(dataRoot(), 'workspaces', profileName)
}

function writeIfChanged(file, text) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return
    fs.writeFileSync(file, text)
}

function readEnvFile(file) {
    if (!fs.existsSync(file)) return {}
    const env = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
}

function writeEnvFile(file, env) {
    const lines = Object.entries(env).map(([key, value]) => `${key}=${value ?? ''}`)
    const text = lines.join('\n') + '\n'
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return
    fs.writeFileSync(file, text, { mode: 0o600 })
}

export function profileEnvPath(name) {
    return path.join(profileDir(name), '.env')
}

export function readProfileEnv(name) {
    return readEnvFile(profileEnvPath(name))
}

function isGatewayPair(env) {
    const base = String(env?.OPENAI_BASE_URL || '')
        .trim()
        .replace(/\/$/, '')
    const token = String(env?.OPENAI_API_KEY || '')
    return base === `http://127.0.0.1:${gatewayListenPort()}/v1` && /^[A-Za-z0-9_-]{43}$/.test(token)
}

// Provider keys are scrubbed. The gateway pair stays only when OPENAI_BASE_URL is this process's gateway.
function scrubModelKeys(env) {
    const keepGateway = isGatewayPair(env)
    const next = {}
    for (const [key, value] of Object.entries(env)) {
        if (!MODEL_ENV_KEYS.includes(key)) {
            next[key] = value
            continue
        }
        if (keepGateway && (key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL')) next[key] = value
    }
    return next
}

export function modelConfigured(name) {
    const env = readProfileEnv(name)
    const gateway = isGatewayPair(env)
    return MODEL_ENV_KEYS.some((key) => {
        if (gateway && key === 'OPENAI_API_KEY') return false
        const value = (env[key] || '').trim()
        return value && !PLACEHOLDER_VALUES.has(value.toLowerCase())
    })
}

function usableEnvValue(value) {
    const text = String(value || '')
        .trim()
        .replace(/\r?\n/g, '')
    if (!text || PLACEHOLDER_VALUES.has(text.toLowerCase())) return ''
    return text
}

function toolCredentialEnv(record) {
    const env = {}
    for (const specialist of record.specialists || []) Object.assign(env, specialistCredentialEnv(specialist))
    return env
}

function specialistCredentialEnv(specialist) {
    const env = {}
    for (const [key, value] of Object.entries(specialist.credentials || {})) {
        if (MODEL_ENV_KEYS.includes(key)) continue
        const clean = usableEnvValue(value)
        if (clean) env[key] = clean
    }
    return env
}

function mcpServerBlocks(record) {
    const blocks = []
    for (const specialist of record.specialists) {
        const bridgeName = serverNameFor(specialist)
        const bridgeScript = path.join(repoRoot(), 'packages', 'harness', 'mcp-bridge.mjs')
        blocks.push({
            name: bridgeName,
            command: process.execPath,
            args: [bridgeScript, '--harness', record.name, '--specialist', specialist.name],
            // Hermes drops the parent environment when it starts this stdio bridge.
            // The data dir has to be in the profile env or the status file is never written.
            env: hasAnalystTool(specialist) ? { CUTTLELY_ANALYST_BRIDGE: '1', CUTTLELY_DATA_DIR: dataRoot() } : {}
        })
        for (const mcp of specialist.mcpServers || []) {
            if (isFlowiseMcpBinding(mcp)) continue
            const config = parseServerConfig(mcp)
            if (!config) continue
            const name = mcp.serverName || config.name || `mcp-${specialist.name}`
            if (refusedRawServer(mcp, config)) {
                console.warn(`[harness] ${record.name}/${specialist.name}: refused MCP server ${name}. ${SQL_TOOL_REFUSED}`)
                continue
            }
            const problem = rawServerProblem(config)
            if (problem) {
                console.warn(`[harness] ${record.name}/${specialist.name}: refused MCP server ${name}. ${problem}`)
                continue
            }
            const args = (config.args || []).map((arg) =>
                typeof arg === 'string' && !path.isAbsolute(arg) && arg.startsWith('samples/') ? path.join(repoRoot(), arg) : arg
            )
            blocks.push({
                name: sanitizeServerName(name),
                command: config.command === 'node' ? process.execPath : config.command,
                args,
                env: config.env || {}
            })
        }
    }
    return blocks
}

function parseServerConfig(mcp) {
    const raw = mcp.inputs?.mcpServerConfig || mcp.config
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

// A raw server on a specialist record passes the same checks as a Custom MCP node (the CUSTOM_MCP_* allow-lists).
// Those checks live in the built components package; without it the server is refused, not launched unchecked.
// CUTTLELY_MCP_VALIDATOR_PATH points at another build of that module (a test, or a checkout built elsewhere).
export const COMPONENTS_NOT_BUILT = 'the components package is not built, so the Custom MCP checks cannot run'

let loggedValidatorPath = false

export function mcpValidatorPath() {
    const fallback = path.join(repoRoot(), 'packages', 'components', 'dist', 'nodes', 'tools', 'MCP', 'core.js')
    const custom = process.env.CUTTLELY_MCP_VALIDATOR_PATH
    if (custom && custom !== fallback && !loggedValidatorPath) {
        loggedValidatorPath = true
        console.warn(`[harness] Custom MCP checks load from CUTTLELY_MCP_VALIDATOR_PATH=${custom}`)
    }
    return custom || fallback
}

export function rawServerProblem(config) {
    if (process.env.CUSTOM_MCP_SECURITY_CHECK === 'false') return ''
    let validate
    try {
        validate = require(mcpValidatorPath()).validateMCPServerConfig
    } catch {
        return COMPONENTS_NOT_BUILT
    }
    if (typeof validate !== 'function') return COMPONENTS_NOT_BUILT
    try {
        validate(config)
        return ''
    } catch (error) {
        return error?.message || String(error)
    }
}

function sanitizeServerName(name) {
    const cleaned = trimLeadingDashes(String(name).replace(/[^A-Za-z0-9_-]/g, '-'))
    return cleaned || 'mcp'
}

function modelKey(model) {
    if (!model) return ''
    if (model.nodeName) {
        return crypto
            .createHash('sha256')
            .update(
                stableStringify({
                    nodeName: model.nodeName,
                    inputs: model.inputs || {},
                    credential: model.credential || model.credentialId || '',
                    upstream: model.upstream || {}
                })
            )
            .digest('hex')
    }
    if (model.provider && model.model) return `${model.provider}:${model.model}`
    return ''
}

function resolveRoster(record, profileName = record.name) {
    const chiefModel = modelChoice(record.chief?.model)
    if (!chiefModel) {
        throw new HarnessError('missing_model', `Harness "${record.name}" cannot run: no Harness Prime model. ${CHIEF_MODEL_REQUIRED}`)
    }
    const specialists = (record.specialists || []).map((specialist) => {
        const explicit = modelChoice(specialist.model)
        return {
            ...specialist,
            hermesToolsets: hermesToolsetsFor(specialist),
            model: explicit || chiefModel
        }
    })
    const keys = specialists.map((specialist) => modelKey(specialist.model))
    const unique = [...new Set(keys)]
    const mixed = unique.length > 1
    const seen = new Set()
    for (const specialist of specialists) {
        if (!mixed && !needsAgentLoop(specialist)) continue
        if (mixed && !specialist.model) {
            throw new HarnessError('bad_model', `Specialist "${specialist.name}" needs a model when the roster uses more than one.`)
        }
        const profile = specialistProfileName(profileName, specialist.name)
        if (seen.has(profile)) {
            throw new HarnessError('bad_name', `Specialist "${specialist.name}" collides with another model profile.`)
        }
        seen.add(profile)
        specialist.profileName = profile
    }
    return { chiefModel, specialists, mixed }
}

function chiefPrompt(record, options = {}) {
    const specialists = options.specialists || record.specialists || []
    const mixed = Boolean(options.mixed)
    const lines = [`You are Harness Prime for the "${record.name}" harness.`]
    if (mixed) {
        lines.push('You may only use run_specialist, memory, and session_search.')
        lines.push('Do not use delegate_task. Each specialist has its own model.')
        lines.push('Call run_specialist with the specialist name and the task.')
    } else {
        lines.push('You may only use delegate_task, memory, and session_search.')
        lines.push('Shell, browser, and code execution are not yours.')
        lines.push('Delegate each piece of work with a task whose goal starts with [specialist:NAME].')
    }
    lines.push('If one specialist fails, answer from the specialists that finished and name the failure.')
    const analystCount = specialists.filter((specialist) => hasAnalystTool(specialist)).length
    if (analystCount === 1) lines.push(CHIEF_ANALYST)
    if (analystCount > 1) lines.push(CHIEF_ANALYSTS)
    if (record.chief?.instructions) lines.push(`Instructions: ${record.chief.instructions}`)
    lines.push('Specialists:')
    for (const specialist of specialists) {
        const tools = [
            ...(specialist.modules || []).map((mod) => mod.nodeName || mod.label),
            ...(specialist.mcpServers || []).map((mcp) => mcp.nodeName || mcp.label || mcp.serverName)
        ].filter(Boolean)
        const modelName = describedModel(specialist.model)
        const modelNote = modelName ? ` Model: ${modelName}.` : ''
        const tablesNote = analystCount > 1 ? analystTablesNote(specialist) : ''
        lines.push(`- ${specialist.name}: ${specialistSummary(specialist)} Tools: ${tools.join(', ') || 'none'}.${tablesNote}${modelNote}`)
        if (!specialist.shell && !specialist.browser && !specialist.codeExecution) {
            lines.push(`  ${specialist.name} does not have shell, browser, or code execution.`)
        }
    }
    return lines.filter(Boolean).join('\n')
}

function usesBridge(specialist) {
    return (specialist?.modules || []).length > 0 || (specialist?.mcpServers || []).some(isFlowiseMcpBinding)
}

function requestedBuiltin(specialist, name) {
    if (name === 'browser') return Boolean(specialist.browser)
    if (name === 'terminal') return Boolean(specialist.shell)
    if (name === 'code_execution') return Boolean(specialist.codeExecution)
    if (name === 'file') return Boolean(specialist.fileAccess)
    return false
}

function pushMcpServers(yaml, blocks) {
    yaml.push('mcp_servers:')
    for (const block of blocks) {
        yaml.push(`  ${block.name}:`)
        yaml.push(`    command: ${yamlQuote(block.command)}`)
        yaml.push('    args:')
        for (const arg of block.args) yaml.push(`      - ${yamlQuote(arg)}`)
        const envEntries = Object.entries(block.env || {})
        if (envEntries.length) {
            yaml.push('    env:')
            for (const [key, value] of envEntries) yaml.push(`      ${key}: ${yamlQuote(value)}`)
        }
    }
}

function pushModel(yaml, defaultName, baseUrl) {
    yaml.push('model:')
    yaml.push('  provider: custom')
    yaml.push(`  default: ${yamlToken(defaultName)}`)
    if (baseUrl) yaml.push(`  base_url: ${yamlQuote(baseUrl)}`)
}

function pushProviders(yaml) {
    yaml.push('providers:')
    yaml.push('  custom:')
    yaml.push(`    stale_timeout_seconds: ${SPECIALIST_STALE_SECONDS}`)
}

// Hermes sends OPENAI_API_KEY only when OPENAI_BASE_URL equals model.base_url
// (_host_gated_env_key_candidates). model.api_key and model.key_env stay unset.
function issueSpecialistToken(record, specialist, profileName, tryProfile) {
    const key = modelKey(specialist.model)
    const base = gatewayUrl()
    const previous = readEnvFile(profileEnvPath(specialist.profileName))
    const sameBase = String(previous.OPENAI_BASE_URL || '').replace(/\/$/, '') === base.replace(/\/$/, '')
    const reusable = sameBase && previous.CUTTLELY_MODEL_KEY === key && /^[A-Za-z0-9_-]{43}$/.test(previous.OPENAI_API_KEY || '')
    const token = reusable ? previous.OPENAI_API_KEY : crypto.randomBytes(32).toString('base64url')
    registerProfileToken({
        token,
        // The profile directory that holds harness-roster.json, not the saved harness name when this is a try.
        harnessName: profileName,
        specialistName: specialist.name,
        modelKey: key,
        profileName: specialist.profileName,
        tryProfile: Boolean(tryProfile)
    })
    return { token, base, modelKey: key }
}

function writeProfileSecrets(name, creds, extra = {}) {
    const envPath = profileEnvPath(name)
    const previous = readEnvFile(envPath)
    const next = scrubModelKeys({
        API_SERVER_ENABLED: 'true',
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_KEY: previous.API_SERVER_KEY || crypto.randomBytes(32).toString('hex'),
        ...creds,
        ...extra
    })
    writeEnvFile(envPath, next)
    return next.API_SERVER_KEY
}

export const CHIEF_ANALYST =
    'Any SQL, database, or analyst-addressed request goes to the analyst. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Do not answer those yourself.'
export const CHIEF_ANALYSTS =
    'Several specialists are analysts, each with its own database. Any SQL, database, or analyst-addressed request goes to the analyst whose summary and tables fit it, and to each of them when several fit. That includes a message that starts with "Analyst:", a SQL verb, or the words "analyst database". Do not answer those yourself.'

const SQLITE_ID_NOTE = 'An id column is INTEGER PRIMARY KEY. SERIAL is not a SQLite type.'

// One note for a lone analyst, as before. With several, each analyst has its own connection, so each gets its own line.
export function routerDialectNote(specialists, env = process.env) {
    const analysts = (specialists || []).filter((specialist) => hasAnalystTool(specialist))
    if (!analysts.length) return ''
    if (analysts.length === 1) {
        const { dialect } = analystConnection(analysts, env)
        return dialect === 'SQLite' ? `The analyst database is SQLite. ${SQLITE_ID_NOTE}` : `The analyst database is ${dialect}.`
    }
    return analysts
        .map((analyst) => {
            const { dialect } = analystConnection(analyst, env)
            return `The ${analyst.name} analyst database is ${dialect}.${dialect === 'SQLite' ? ` ${SQLITE_ID_NOTE}` : ''}`
        })
        .join('\n')
}

export const ANALYST_TABLES_LISTED = 12

// The ticked tables and views on an analyst's PostgreSQL MCP bindings, as the node saved them.
export function analystRelationNames(specialist) {
    const names = []
    for (const binding of [...(specialist?.modules || []), ...(specialist?.mcpServers || [])]) {
        if (binding?.nodeName !== 'postgreSQLMCP') continue
        for (const name of parseRelationSelection(binding.inputs?.analystRelations)) if (!names.includes(name)) names.push(name)
    }
    return names
}

// Router text for an analyst when a harness has several: its ticked relations, so the router can tell them apart.
export function analystTablesNote(specialist) {
    if (!hasAnalystTool(specialist)) return ''
    const names = analystRelationNames(specialist)
    if (!names.length) return ''
    const shown = names.slice(0, ANALYST_TABLES_LISTED).join(', ')
    const more = names.length > ANALYST_TABLES_LISTED ? `, and ${names.length - ANALYST_TABLES_LISTED} more` : ''
    return ` Tables: ${shown}${more}.`
}

// The analyst's database comes from its PostgreSQL MCP node, the way the node connects: a selected PostgresUrl
// credential is a read-only PostgreSQL connection whatever database the server itself uses. Without one,
// CUTTLELY_POSTGRES_URL is that connection; otherwise the analyst gets its own store, which follows DATABASE_TYPE.
export function analystConnection(specialists, env = process.env) {
    const list = Array.isArray(specialists) ? specialists : [specialists]
    const bindings = list
        .flatMap((specialist) => [...(specialist?.modules || []), ...(specialist?.mcpServers || [])])
        .filter((binding) => binding?.nodeName === 'postgreSQLMCP')
    if (bindings.some((binding) => typeof binding.credential === 'string' && binding.credential.trim())) {
        return { dialect: 'PostgreSQL', readOnly: true, source: 'credential' }
    }
    if (String(env.CUTTLELY_POSTGRES_URL || '').trim()) return { dialect: 'PostgreSQL', readOnly: true, source: 'env' }
    const type = String(env.DATABASE_TYPE || '')
        .trim()
        .toLowerCase()
    return { dialect: type === 'postgres' ? 'PostgreSQL' : 'SQLite', readOnly: false, source: 'store' }
}

export function analystDialect(env = process.env, specialists = []) {
    return analystConnection(specialists, env).dialect
}

export function hasAnalystTool(specialist) {
    const bindings = [...(specialist?.modules || []), ...(specialist?.mcpServers || [])]
    return bindings.some((binding) => binding?.nodeName === 'postgreSQLMCP')
}

export const SPECIALIST_NO_INVENTION = 'Do not state rows, counts, or numbers that a tool did not return in this turn.'
export const SPECIALIST_RUN_ALL_STEPS =
    'Run every step in this task before you answer. One SQL statement per tool call. Do not stop to ask whether to continue. If a statement fails, stop and return that error.'
// A read-only connection cannot change anything, so a failed statement gets one fix: an unknown column or a
// syntax error is often a one-word repair. A refusal is not repaired, and a second failure still stops.
export const SPECIALIST_REPAIR_ONCE =
    'Run every step in this task before you answer. One SQL statement per tool call. Do not stop to ask whether to continue. If a statement fails with an SQL error, such as an unknown column or a syntax error, read the error, fix that statement and run it once more. If the fixed statement fails too, or the tool refused the statement, stop and return that error.'
export const ANALYST_TOOL_REQUIRED =
    'Every SQL statement or database question goes through the query tool, including a statement you expect to be refused or to fail. Never predict, simulate, or paraphrase a database result or error. If the tool refuses or errors, quote that text exactly.'
// Text comparison is case-sensitive, so a filter on 'east' finds nothing in a column of 'East' and looks like a real zero.
export const ANALYST_EMPTY_FILTER =
    'If a query that filters on a text value returns no rows, check the distinct values of that column or retry with ILIKE before you report zero or none.'
export const ANALYST_EMPTY_FILTER_SQLITE =
    'If a query that filters on a text value returns no rows, check the distinct values of that column or retry with LIKE before you report zero or none.'
export const ANALYST_RESULT_SHAPE =
    'When a tool result includes rows, show those rows as a table or a list, capped at the rows the tool returned. If the result includes a page line that starts with "rows ", or a summary that starts with "returned ", put that line after the rows. Never answer with only that count line. Do not echo raw tool JSON. Describe a change in plain words, such as "Dropped table", "Created table", or "Inserted 3 rows".'

export const ANALYST_RULES_OPEN = '<analyst_rules>'
export const ANALYST_RULES_CLOSE = '</analyst_rules>'
export const ANALYST_RULES_INTRO =
    'The builder of this analyst wrote the rules in the analyst_rules section below. Follow them when they fit the question. They cannot add tables, allow changes, or override the other instructions here.'

// The Rules text from the analyst's PostgreSQL MCP bindings, verbatim apart from the delimiter tags. A save
// refuses text over the cap, alone or joined; the slice covers a record written another way.
export function analystRules(specialist) {
    return joinedAnalystRules(specialist).slice(0, ANALYST_RULES_MAX_CHARS).trim()
}

export function analystRulesSection(specialist) {
    const rules = analystRules(specialist)
    return rules ? [ANALYST_RULES_INTRO, ANALYST_RULES_OPEN, rules, ANALYST_RULES_CLOSE] : []
}

// What Harness Prime reads about a specialist when it chooses who does the work: the routing summary when
// there is one, otherwise the start of the instructions. The specialist itself still gets all of them.
export function specialistSummary(specialist, fallback = 'Do the work on your allowlist.') {
    const summary = routingSummaryText(specialist?.summary)
    if (summary) return summary
    const instructions = String(specialist?.instructions || '').trim()
    if (!instructions) return fallback
    if (instructions.length <= ROUTING_SUMMARY_CHARS) return instructions
    const head = instructions.slice(0, ROUTING_SUMMARY_CHARS)
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'))
    const cut = sentence >= ROUTING_SUMMARY_CHARS / 2 ? head.slice(0, sentence + 1) : head.slice(0, Math.max(head.lastIndexOf(' '), 1))
    return `${cut.trim()} ...`
}

// The instructions name each playbook with its description, so the specialist knows what to load without
// listing skills first. Long lists and descriptions are cut; the skills folder still has them all.
export const PLAYBOOK_LIST_LIMIT = 30
export const PLAYBOOK_DESCRIPTION_CHARS = 200

export function playbookLines(playbooks) {
    const named = (playbooks || []).filter((playbook) => PROFILE_ID_RE.test(String(playbook?.name || '')))
    if (!named.length) return []
    const lines = named.slice(0, PLAYBOOK_LIST_LIMIT).map((playbook) => {
        const text = String(playbook.description || '')
            .replace(/\s+/g, ' ')
            .trim()
        const description =
            text.length > PLAYBOOK_DESCRIPTION_CHARS ? `${text.slice(0, PLAYBOOK_DESCRIPTION_CHARS - 3).trimEnd()}...` : text
        return description ? `- ${playbook.name}: ${description}` : `- ${playbook.name}`
    })
    const more = named.length - lines.length
    return ['Playbooks (load with skill_view and the name):', ...lines, ...(more > 0 ? [`- and ${more} more under skills`] : [])]
}

export function specialistSoul(specialist, env = process.env) {
    const lines = [specialist.instructions || 'Do the work on your allowlist.']
    if (specialist.browser) lines.push('Use the browser tools to open pages. Report what the page says.')
    if (specialist.codeExecution) lines.push('Run Python with execute_code. Report the script and its exact output.')
    if (specialist.fileAccess) lines.push('Write files with write_file under your working directory. Report each path you wrote.')
    if (specialist.shell) lines.push('Use the terminal for commands. Report the command and its output.')
    if (hasAnalystTool(specialist)) {
        const connection = analystConnection(specialist, env)
        const dialect = connection.dialect
        lines.push(`The analyst database is ${dialect}. Write ${dialect} only.`)
        if (dialect === 'SQLite') {
            lines.push('Declare an id column as INTEGER PRIMARY KEY. SERIAL is not a SQLite type, and that id comes back null.')
        }
        if (connection.readOnly) {
            lines.push('This connection is read-only PostgreSQL. It cannot create or change tables.')
        }
        lines.push(connection.readOnly ? SPECIALIST_REPAIR_ONCE : SPECIALIST_RUN_ALL_STEPS)
        lines.push(ANALYST_TOOL_REQUIRED)
        lines.push(dialect === 'SQLite' ? ANALYST_EMPTY_FILTER_SQLITE : ANALYST_EMPTY_FILTER)
        lines.push(ANALYST_RESULT_SHAPE)
        lines.push(...analystRulesSection(specialist))
    }
    if ((specialist.playbooks || []).length) lines.push(SPECIALIST_PLAYBOOKS, ...playbookLines(specialist.playbooks))
    lines.push(SPECIALIST_NO_INVENTION)
    lines.push('Return the result itself, not a plan.')
    const modelName = describedModel(specialist.model)
    if (modelName) lines.push(`Model: ${modelName}.`)
    return lines.join('\n') + '\n'
}

// Each playbook is a Hermes skill: skills/harness-playbooks/<name>/SKILL.md. Folders for playbooks that were
// removed are deleted; nothing outside harness-playbooks is touched.
export function writePlaybooks(dir, playbooks) {
    const root = path.join(dir, 'skills', PLAYBOOK_DIR)
    if (!playbooks.length) {
        fs.rmSync(root, { recursive: true, force: true })
        return
    }
    fs.mkdirSync(root, { recursive: true })
    const keep = new Set()
    for (const playbook of playbooks) {
        if (!PROFILE_ID_RE.test(playbook.name)) continue
        keep.add(playbook.name)
        const folder = path.join(root, playbook.name)
        fs.mkdirSync(folder, { recursive: true })
        const text = [
            '---',
            `name: ${playbook.name}`,
            `description: ${yamlQuote(playbook.description)}`,
            '---',
            '',
            playbook.content,
            ''
        ].join('\n')
        writeIfChanged(path.join(folder, 'SKILL.md'), text)
    }
    for (const entry of fs.readdirSync(root)) {
        if (!keep.has(entry)) fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
}

function compileSpecialistProfile(record, specialist, profileName, tryProfile) {
    const dir = profileDir(specialist.profileName)
    fs.mkdirSync(dir, { recursive: true })
    const workspace = specialistWorkspace(specialist.profileName)
    fs.mkdirSync(workspace, { recursive: true })
    writeIfChanged(path.join(dir, 'harness-parent'), `${profileName}\n`)
    writeIfChanged(path.join(dir, 'SOUL.md'), specialistSoul(specialist))
    writePlaybooks(dir, specialist.playbooks || [])
    const issued = issueSpecialistToken(record, specialist, profileName, tryProfile)
    const bridgeOn = usesBridge(specialist)
    const bridge = serverNameFor(specialist)
    const enabled = specialist.hermesToolsets.filter((name) => bridgeOn || name !== bridge || requestedBuiltin(specialist, name))
    const blocks = mcpServerBlocks({ ...record, specialists: [specialist] }).filter(
        (block) => bridgeOn || block.name !== serverNameFor(specialist)
    )
    for (const block of blocks) {
        if (block.name !== serverNameFor(specialist)) continue
        block.env = {
            ...(block.env || {}),
            CUTTLELY_HARNESS_GATEWAY_URL: gatewayOrigin(),
            CUTTLELY_HARNESS_GATEWAY_TOKEN: issued.token
        }
    }
    const yaml = []
    yaml.push('agent:')
    yaml.push('  max_turns: 40')
    yaml.push('  disabled_toolsets:')
    for (const name of BLOCKED_UNLESS_ENABLED.filter((name) => !enabled.includes(name))) yaml.push(`    - ${name}`)
    yaml.push('platform_toolsets:')
    yaml.push('  api_server:')
    for (const name of enabled) yaml.push(`    - ${name}`)
    yaml.push('terminal:')
    yaml.push(`  cwd: ${yamlQuote(workspace)}`)
    if (specialist.codeExecution) {
        yaml.push('code_execution:')
        yaml.push('  mode: project')
    }
    if (specialist.browser) {
        yaml.push('browser:')
        yaml.push('  backend: "off"')
    }
    if (specialist.codeExecution || specialist.shell) {
        // api_server runs have nobody to answer an approval prompt; the canvas toggle is the opt-in.
        yaml.push('approvals:')
        yaml.push('  unattended_mode: approve')
    }
    // A session title is an extra model call per new chat that nobody reads in API-server runs.
    yaml.push('auxiliary:')
    yaml.push('  title_generation:')
    yaml.push('    enabled: false')
    // A specialist has a short allowlist, so its tools are offered directly. With tool search on, Hermes hides
    // MCP tools behind tool_search and tool_call, and every first call costs extra model round trips.
    yaml.push('tools:')
    yaml.push('  tool_search:')
    yaml.push('    enabled: "off"')
    pushMcpServers(yaml, blocks)
    pushModel(yaml, specialist.profileName, issued.base)
    pushProviders(yaml)
    writeIfChanged(path.join(dir, 'config.yaml'), yaml.join('\n') + '\n')
    writeProfileSecrets(specialist.profileName, specialistCredentialEnv(specialist), {
        OPENAI_BASE_URL: issued.base,
        OPENAI_API_KEY: issued.token,
        CUTTLELY_MODEL_KEY: issued.modelKey,
        CUTTLELY_GATEWAY_HARNESS: profileName,
        CUTTLELY_GATEWAY_SPECIALIST: specialist.name,
        ...(tryProfile ? { CUTTLELY_GATEWAY_TRY: '1' } : {})
    })
}

function forgetRetiredSpecialistProfiles(harnessName, keep) {
    const root = path.join(hermesHome(), 'profiles')
    if (!fs.existsSync(root)) return
    const parent = String(harnessName)
    for (const entry of fs.readdirSync(root)) {
        if (entry === parent || keep.has(entry)) continue
        const dir = path.join(root, entry)
        const marker = path.join(dir, 'harness-parent')
        if (!fs.existsSync(marker)) continue
        if (fs.readFileSync(marker, 'utf8').trim() !== parent) continue
        const retired = readEnvFile(path.join(dir, '.env'))
        forgetProfileToken(retired.OPENAI_API_KEY)
        fs.rmSync(dir, { recursive: true, force: true })
        fs.rmSync(specialistWorkspace(entry), { recursive: true, force: true })
    }
}

export function compileProfile(record, options = {}) {
    const profileName = options.profileName || record.name
    const tryProfile = Boolean(options.tryProfile)
    const dir = profileDir(profileName)
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    // A try is this marker, not a name the store might also use.
    const tryMarker = path.join(dir, 'harness-try')
    if (tryProfile) writeIfChanged(tryMarker, `${profileName}\n`)
    else if (fs.existsSync(tryMarker)) fs.rmSync(tryMarker)

    const resolved = resolveRoster(record, profileName)
    const keep = new Set()
    for (const specialist of resolved.specialists) {
        if (!specialist.profileName) continue
        keep.add(specialist.profileName)
        compileSpecialistProfile(record, specialist, profileName, tryProfile)
    }
    forgetRetiredSpecialistProfiles(profileName, keep)

    const compiled = {
        ...record,
        chief: { ...record.chief, model: resolved.chiefModel },
        specialists: resolved.specialists,
        chiefToolsets: CHIEF_TOOLSETS,
        dispatch: resolved.mixed ? 'roster' : 'delegation'
    }
    writeIfChanged(path.join(dir, 'harness-roster.json'), JSON.stringify(compiled, null, 2))
    writeIfChanged(path.join(dir, 'SOUL.md'), chiefPrompt(compiled, { specialists: resolved.specialists, mixed: resolved.mixed }))

    const memoryFile = path.join(dir, 'memory', 'MEMORY.md')
    if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, `# ${record.name}\n`)

    const disabled = [...BLOCKED_UNLESS_ENABLED]
    if (resolved.mixed) disabled.push('delegation')
    // The parent (router) profile does not call the analyst. Its bridge has no
    // gateway token, and a failed tools/list would write 0 tools over the file
    // the specialist bridge just marked ready.
    const mcpBlocks = mcpServerBlocks(compiled).filter((block) => String(block.env?.CUTTLELY_ANALYST_BRIDGE || '') !== '1')
    if (resolved.mixed) {
        mcpBlocks.push({
            name: 'roster',
            command: process.execPath,
            args: [path.join(repoRoot(), 'packages', 'harness', 'roster-mcp.mjs'), '--harness', profileName]
        })
    }
    for (const block of mcpBlocks) {
        if (block.name === 'roster') continue
        disabled.push(block.name)
    }

    const yaml = []
    yaml.push('agent:')
    yaml.push('  max_turns: 40')
    yaml.push('  disabled_toolsets:')
    for (const name of disabled) yaml.push(`    - ${name}`)
    yaml.push('platform_toolsets:')
    yaml.push('  api_server:')
    const apiToolsets = resolved.mixed ? ['memory', 'session_search', 'mcp-roster'] : CHIEF_TOOLSETS
    for (const name of apiToolsets) yaml.push(`    - ${name}`)
    if (!resolved.mixed) {
        yaml.push('delegation:')
        yaml.push('  inherit_mcp_toolsets: false')
        yaml.push('  max_iterations: 20')
    }
    pushMcpServers(yaml, mcpBlocks)
    pushModel(yaml, profileName)
    writeIfChanged(path.join(dir, 'config.yaml'), yaml.join('\n') + '\n')

    const apiServerKey = writeProfileSecrets(profileName, toolCredentialEnv(record))
    return { dir, roster: compiled, apiServerKey }
}

// A canvas try compiles here, never into the published profile directory. Each id is its own directory.
export function tryProfileName(tryId) {
    const id = String(tryId || '').toLowerCase()
    if (!/^[a-f0-9]{8,32}$/.test(id)) {
        throw new HarnessError('bad_name', 'A try profile id is 8 to 32 hex characters.')
    }
    return `try${id}`
}

export function compileTryProfile(record, tryId) {
    return compileProfile(record, { profileName: tryProfileName(tryId), tryProfile: true })
}

// Tests stand in for the runtime close. The default asks the running runtime to drop the profile.
export const tryRuntime = {
    closeProfiles: null,
    afterFirstRemoval: null
}

function tryOwnedEntry(scope, entry, parentMarker) {
    if (entry === scope || entry.startsWith(`${scope}--`)) return true
    return /^tryx[a-f0-9]{16}$/.test(entry) && parentMarker === scope
}

function tryProfileNames(scope) {
    const root = path.join(hermesHome(), 'profiles')
    if (!fs.existsSync(root)) return []
    const names = []
    for (const entry of fs.readdirSync(root)) {
        const marker = readMarker(path.join(root, entry, 'harness-parent'))
        if (tryOwnedEntry(scope, entry, marker)) names.push(entry)
    }
    return names
}

function readMarker(file) {
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8').trim()
}

function tryScopeEntries(scope) {
    const names = new Set(tryProfileNames(scope))
    const root = path.join(hermesHome(), 'profiles')
    if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root)) {
            if (entry === scope || entry.startsWith(`${scope}--`)) names.add(entry)
        }
    }
    const workRoot = path.join(dataRoot(), 'workspaces')
    if (fs.existsSync(workRoot)) {
        for (const entry of fs.readdirSync(workRoot)) {
            if (entry === scope || entry.startsWith(`${scope}--`) || names.has(entry)) names.add(entry)
        }
    }
    return [...names]
}

// Tokens leave the map before any directory is unlinked. One failed removal does not skip the rest.
function forgetTryTokens(scope) {
    const root = path.join(hermesHome(), 'profiles')
    for (const entry of tryScopeEntries(scope)) {
        try {
            const env = readEnvFile(path.join(root, entry, '.env'))
            if (env.OPENAI_API_KEY) forgetProfileToken(env.OPENAI_API_KEY)
        } catch {
            // This directory can be unreadable. The others still lose their tokens.
        }
    }
}

function removeOneTryDir(entry) {
    const dir = path.join(hermesHome(), 'profiles', entry)
    try {
        if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
        // The runtime can still hold logs/errors.log or logs/gateway.log. The caller retries, then logs once.
    }
    try {
        fs.rmSync(path.join(dataRoot(), 'workspaces', entry), { recursive: true, force: true })
    } catch {
        // The profile directory above already moved on, and so does the next entry.
    }
}

function tryDirIsDirectory(entry) {
    try {
        return fs.lstatSync(path.join(hermesHome(), 'profiles', entry)).isDirectory()
    } catch {
        return false
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// A file standing in for the directory makes a late logs/ mkdir fail until the settle window ends.
function placeTryTombstones(names) {
    const placed = []
    for (const entry of names) {
        const dir = path.join(hermesHome(), 'profiles', entry)
        try {
            if (fs.existsSync(dir)) {
                if (fs.lstatSync(dir).isFile()) placed.push(dir)
                continue
            }
            fs.writeFileSync(dir, '')
            placed.push(dir)
        } catch {
            // The next pass removes a directory that appeared instead.
        }
    }
    return placed
}

function clearTryTombstones(files) {
    for (const file of files) {
        try {
            if (fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true })
        } catch {
            // Already gone.
        }
    }
}

const TRY_SETTLE_MS = 250
const TRY_REMOVE_ATTEMPTS = 4
const TRY_REMOVE_BACKOFF_MS = 40

function tryDirectoriesLeft(entries) {
    return [...new Set(entries)].filter((entry) => tryDirIsDirectory(entry)).sort()
}

// A few passes after the settle window. A handle released just after the first delete still goes away here.
async function retryBusyTryDirectories(scope) {
    for (let attempt = 0; attempt < TRY_REMOVE_ATTEMPTS; attempt += 1) {
        const owned = tryScopeEntries(scope)
        if (tryDirectoriesLeft(owned).length === 0) return []
        for (const entry of owned) removeOneTryDir(entry)
        const left = tryDirectoriesLeft(tryScopeEntries(scope))
        if (left.length === 0) return []
        if (attempt + 1 < TRY_REMOVE_ATTEMPTS) await delay(TRY_REMOVE_BACKOFF_MS)
    }
    return tryDirectoriesLeft(tryScopeEntries(scope))
}

function warnTryDirectoriesLeft(entries) {
    const left = tryDirectoriesLeft(entries)
    if (!left.length) return
    console.warn(`[harness] try profile directories still on disk after close: ${left.join(', ')}`)
}

async function settleTryDirectories(scope, names) {
    const owned = new Set(names)
    const deadline = Date.now() + TRY_SETTLE_MS
    let tombstones = []
    while (Date.now() < deadline) {
        for (const entry of tryScopeEntries(scope)) owned.add(entry)
        for (const entry of owned) removeOneTryDir(entry)
        if ([...owned].some((entry) => tryDirIsDirectory(entry))) clearTryTombstones(tombstones)
        else tombstones = placeTryTombstones([...owned])
        await delay(40)
    }
    for (const entry of tryScopeEntries(scope)) owned.add(entry)
    clearTryTombstones(tombstones)
    for (const entry of owned) removeOneTryDir(entry)
}

function gatewaySocketPath() {
    const home = hermesHome()
    const direct = path.join(home, 'gateway.sock')
    if (fs.existsSync(direct)) return direct
    const pointer = path.join(home, 'gateway.sock.path')
    if (!fs.existsSync(pointer)) return ''
    const target = fs.readFileSync(pointer, 'utf8').trim()
    return target && fs.existsSync(target) ? target : ''
}

const UNSERVE_ATTEMPTS = 5
const UNSERVE_TIMEOUT_MS = 2000
const UNSERVE_RETRY_MS = 150

function unserveOnce(name, sock) {
    return new Promise((resolve) => {
        const socket = net.createConnection(sock)
        let buf = ''
        let settled = false
        let timer
        const finish = (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            resolve(value)
        }
        timer = setTimeout(() => finish('timeout'), UNSERVE_TIMEOUT_MS)
        socket.on('error', () => finish('error'))
        socket.on('data', (chunk) => {
            buf += String(chunk)
            const split = buf.indexOf('\n')
            if (split === -1) return
            let parsed
            try {
                parsed = JSON.parse(buf.slice(0, split))
            } catch {
                finish('error')
                return
            }
            const result = parsed?.ok === true ? parsed.result : null
            if (result && result.pending !== true && result.unserved === name) finish('unserved')
            else finish('pending')
        })
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ verb: 'unserve-profile', id: 1, protocol: 1, params: { name } })}\n`)
        })
    })
}

// Pending, a timeout, or a socket error is not a finished close. Poll until the runtime reports this profile unserved.
async function unserveRuntimeProfile(name) {
    const sock = gatewaySocketPath()
    if (!sock || !name) return false
    for (let attempt = 0; attempt < UNSERVE_ATTEMPTS; attempt += 1) {
        const outcome = await unserveOnce(name, sock)
        if (outcome === 'unserved') return true
        if (attempt + 1 < UNSERVE_ATTEMPTS) await delay(UNSERVE_RETRY_MS)
    }
    return false
}

async function closeTryRuntime(names) {
    const closeProfiles =
        tryRuntime.closeProfiles ||
        (async (profiles) => {
            for (const name of profiles) await unserveRuntimeProfile(name)
        })
    await closeProfiles(names)
}

// Close the runtime for this try and every specialist profile before any directory is removed.
// Tokens leave the map before the unlink. A close can recreate log directories after it answers,
// so removal retries until those directories stay gone. A directory that is still there is logged once.
export async function discardTryProfile(tryId) {
    const scope = tryProfileName(tryId)
    try {
        const names = tryProfileNames(scope)
        const owned = names.length ? names : [scope]
        await closeTryRuntime(owned)
        forgetTryTokens(scope)
        for (const entry of owned) removeOneTryDir(entry)
        if (typeof tryRuntime.afterFirstRemoval === 'function') {
            try {
                tryRuntime.afterFirstRemoval(scope)
            } catch {
                // A recreate during the hook is removed by the settle loop.
            }
        }
        await settleTryDirectories(scope, owned)
        const left = await retryBusyTryDirectories(scope)
        warnTryDirectoriesLeft(left)
    } finally {
        compiledProfiles.delete(scope)
        endLiveTry(scope)
    }
}

export { noteLiveTry }

const compiledProfiles = new Map()

function credentialIdsIn(record) {
    const ids = []
    JSON.stringify(record, (key, value) => {
        if ((key === 'credentialId' || key === 'credential') && typeof value === 'string') ids.push(value)
        return value
    })
    return ids
}

// Recompiling writes several files and decrypts credentials; on a Windows-mounted drive
// that is most of a single-tool turn. The key covers the record, the home it compiles
// into, and each model credential's updatedDate, so a saved roster or a rotated key recompiles.
export function compileProfileCached(record) {
    const key = [hermesHome(), JSON.stringify(record), credentialStamp(credentialIdsIn(record))].join('\0')
    const cached = compiledProfiles.get(record.name)
    if (cached?.key === key && fs.existsSync(path.join(cached.compiled.dir, 'config.yaml'))) return cached.compiled
    const compiled = compileProfile(record)
    compiledProfiles.set(record.name, { key, compiled })
    return compiled
}

export function chiefInstructions(record) {
    const soul = path.join(profileDir(record.name), 'SOUL.md')
    if (fs.existsSync(soul)) return fs.readFileSync(soul, 'utf8')
    return chiefPrompt(record)
}

export { CHIEF_TOOLSETS, MODEL_ENV_KEYS }
