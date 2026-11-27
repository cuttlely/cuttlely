import { publishedCanvasSource } from '../canvas-ownership.mjs'
import { CHARS_PER_TOKEN } from '../context.mjs'
import { fromMarkdown } from 'mdast-util-from-markdown'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { profileDir } from '../paths.mjs'
import { specialistSessionId } from '../specialist-run.mjs'
import { PLAYBOOK_DIR, playbookMarkdown, specialistProfileName, tryProfileName } from '../profile.mjs'

const components = createRequire(new URL('../../components/package.json', import.meta.url))
const rootPrefix = () => '/skills/' + PLAYBOOK_DIR + '/'
const maxCompanions = 32
const maxBookBytes = 256 * 1024
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
const companion =
    /^(?:references|templates|assets)\/(?:[A-Za-z0-9_-]+\/){0,5}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.(?:md|txt|json|ya?ml|csv|tex|toml)$/i
const linkedToken = /\$\{HERMES_SKILL_DIR\}/g
const template = /\$\{(?:HERMES_SKILL_DIR|HERMES_SESSION_ID)\}/
const inline = /!`[^`\n]+`/

// Pin each parent descriptor. The metadata and bytes always refer to the same regular file.
// The caller supplies only validated or deployment-derived absolute paths.
function readBounded(file, max, optional) {
    const flags = fs.constants
    if (process.platform !== 'linux') {
        if (optional && !fs.existsSync(file)) return null
        throw Error('Host file verification is unavailable.')
    }
    const parts = file.split('/').slice(1)
    if (!path.isAbsolute(file) || parts.some((part) => !part || part === '..' || part === '.')) throw Error('Invalid deployment path.')
    const opened = []
    try {
        let here = '/'
        for (const component of parts.slice(0, -1)) {
            const fd = fs.openSync(path.join(here, component), flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
            opened.push(fd)
            here = '/proc/self/fd/' + fd
        }
        const fd = fs.openSync(path.join(here, parts.at(-1)), flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK)
        opened.push(fd)
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > max) throw Error('Unverified playbook file.')
        const bytes = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < bytes.length) {
            const count = fs.readSync(fd, bytes, length, bytes.length - length, length)
            if (!count) break
            length += count
        }
        if (length !== stat.size) throw Error('Playbook file changed.')
        return bytes.subarray(0, length)
    } catch (error) {
        if (optional && error.code === 'ENOENT') return null
        throw error
    } finally {
        for (const fd of opened.reverse()) fs.closeSync(fd)
    }
}

const companionPath = /^(?:\.\/)?(?:references|templates|assets|scripts)\//
const imperativeStart = String.raw`(?:^|[.!?;:,]\s+|\bthen\s+)`
const modalStart = String.raw`\b(?:must|should|needs?\s+to|ha(?:s|ve)\s+to|required\s+to|expected\s+to|be\s+sure\s+to)\s+`
const instruction = `(?:${imperativeStart}|${modalStart})(?:(?:please|first|also|always|carefully|directly)\\s+){0,3}(?:read|open|load|run|execute|source|invoke|apply|consult|include)`
const fileAction = new RegExp(instruction + '\\s*$', 'i')
const actionPath = new RegExp(instruction + `\\s+((?:\\.\\/)?(?:references|templates|assets|scripts)\\/[^\\s"'\`()<>,;\\]]+)`, 'gim')

// Markdown examples are not file assignments. A local link, a directory template used in
// prose, or an instruction to open a relative path is. Disabled inline shell stays literal.
function playbookDependencies(book) {
    const text = book.content || ''
    const found = { relative: new Set(), templates: [] }
    if (!text.includes('${HERMES_SKILL_DIR}') && !/(?:references|templates|assets|scripts)\//.test(text)) return found
    const tree = fromMarkdown(text)
    const definitions = new Map()
    const used = new Set()
    const add = (url) => {
        if (typeof url !== 'string') return
        const name = url.split('#')[0]
        if (companionPath.test(name)) found.relative.add(name.replace(/^\.\//, ''))
        else if (name.startsWith('${HERMES_SKILL_DIR}')) found.templates.push(name)
    }
    const queue = [tree]
    while (queue.length) {
        const parent = queue.pop()
        for (const [i, node] of (parent.children || []).entries()) {
            if (node.type === 'definition') definitions.set(node.identifier, node.url)
            else if (node.type === 'linkReference' || node.type === 'imageReference') used.add(node.identifier)
            else if (node.type === 'link' || node.type === 'image') add(node.url)
            else if (node.type === 'text') {
                if (node.value.includes('${HERMES_SKILL_DIR}')) found.templates.push(node.value)
                for (const match of node.value.matchAll(actionPath)) add(match[1].replace(/\.$/, ''))
            } else if (node.type === 'inlineCode' && fileAction.test(parent.children[i - 1]?.value || '')) {
                add(node.value)
            }
            if (node.children && !['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) queue.push(node)
        }
    }
    for (const id of used) add(definitions.get(id))
    return found
}

function effectiveSkillFlags(profile) {
    const yaml = components('js-yaml')
    // The bundled safe loader follows YAML 1.1 booleans. Quoted strings stay strings.
    const bool = new yaml.Type('tag:yaml.org,2002:bool', {
        kind: 'scalar',
        resolve: (value) => /^(?:yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|true|True|TRUE|false|False|FALSE)$/.test(value),
        construct: (value) => /^(?:yes|on|true)$/i.test(value)
    })
    const schema = yaml.DEFAULT_SCHEMA.extend({ implicit: [bool] })
    const flags = { template_vars: true, inline_shell: false }
    const managed = (process.env.HERMES_MANAGED_DIR || '').trim() || '/etc/hermes'
    for (const file of [path.join(profileDir(profile), 'config.yaml'), path.join(path.resolve(managed), 'config.yaml')]) {
        const bytes = readBounded(file, 2 * 1024 ** 2, true)
        if (!bytes) continue
        const settings = yaml.load(bytes.toString('utf8'), { schema })?.skills
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue
        for (const key of Object.keys(flags)) if (Object.hasOwn(settings, key)) flags[key] = settings[key]
    }
    // Expanding arbitrary environment variables here could attribute another service's
    // settings to this specialist. A dynamic effective flag needs operator verification.
    for (const value of Object.values(flags))
        if ((typeof value === 'object' && value !== null) || (typeof value === 'string' && /\$\{[^}]+\}/.test(value)))
            throw Error('Unverified playbook preprocessing setting.')
    return { templates: Boolean(flags.template_vars), inlineShell: Boolean(flags.inline_shell) }
}

function needsAsset(text, assets) {
    const localText = text.replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>'"`]+/gi, '')
    for (const match of localText.matchAll(linkedToken)) {
        const tail = match.input.slice(match.index + match[0].length)
        // A bare directory can be displayed. A following path must be a complete literal
        // logical name, delimited by prose or shell quoting rather than interpolation.
        if (!tail || /^[\s'"`)\],.;]/.test(tail)) continue
        const file = /^\/([^\s'"`)\],;]+)/.exec(tail)?.[1]
        const canonical = file?.replace(/\.$/, '')
        if (!canonical || (canonical !== 'SKILL.md' && !assets.has(canonical))) return true
    }
    return false
}

function groupOf(file) {
    const [group, ...rest] = file.split('/')
    if (group === 'references') return rest.length === 1 && file.endsWith('.md') ? group : null
    if (group === 'templates') return /\.(?:md|json|ya?ml|tex)$/.test(file) ? group : null
    return group === 'assets' ? group : null
}

function readManifestBooks(roster, specialist, parent, profile, assets) {
    const manifest = process.env.CUTTLELY_HOST_FILE_MANIFEST
    if (!manifest) return
    const rows = JSON.parse(readBounded(path.resolve(manifest), 1024 * 1024).toString('utf8'))
    if (!Array.isArray(rows) || rows.length > 8192) throw Error('Invalid host file manifest.')
    const base = path.join(profileDir(profile), 'skills', PLAYBOOK_DIR)
    const runtimePrefix = 'runtime/profiles/' + path.basename(profileDir(profile)) + '/skills/' + PLAYBOOK_DIR + '/'
    let total = 0
    let pinnedRoster
    function compiledOwnerMatches(bookName) {
        // A mutable compiler marker identifies only a profile name. A same-named canvas can
        // recreate it. Plain manifest rows require a *deployment-pinned* ownership record.
        // Its roster bytes can be restored after replacement without any transient marker.
        if (pinnedRoster === undefined) {
            pinnedRoster = null
            const target = path.join(profileDir(parent), 'harness-roster.json')
            const runtimePath = 'runtime/profiles/' + path.basename(profileDir(parent)) + '/harness-roster.json'
            const pins = rows.filter((row) => row?.path === target || row?.path === runtimePath)
            if (!roster.tryId && roster.createdAt && pins.length === 1 && /^[a-f0-9]{64}$/.test(pins[0].sha256)) {
                const bytes = readBounded(target, 4 * 1024 ** 2, true)
                if (bytes && createHash('sha256').update(bytes).digest('hex') === pins[0].sha256)
                    pinnedRoster = JSON.parse(bytes.toString('utf8'))
            }
        }
        return (
            pinnedRoster?.workspaceId === roster.workspaceId &&
            pinnedRoster?.chatflowId === roster.chatflowId &&
            pinnedRoster?.createdAt === roster.createdAt &&
            pinnedRoster?.specialists?.some(
                (member) =>
                    member.name === specialist.name &&
                    member.profileName === profile &&
                    member.playbooks?.some((book) => book.name === bookName)
            )
        )
    }
    let needsOwner = false
    for (const row of rows) {
        if (typeof row?.path !== 'string') continue
        const prefix = [base + '/', runtimePrefix].find((p) => row.path.startsWith(p))
        if (!prefix) continue
        const rel = row.path.slice(prefix.length),
            slash = rel.indexOf('/')
        const book = assets.get(rel.slice(0, slash))
        if (slash < 1 || !book) continue
        const file = rel.slice(slash + 1)
        if (file === 'SKILL.md') continue
        const owner = row.playbook
        if (owner !== undefined) {
            if (
                owner?.workspaceId !== roster.workspaceId ||
                owner?.chatflowId !== roster.chatflowId ||
                !roster.createdAt ||
                owner.generation !== roster.createdAt ||
                (owner.tryId || '') !== (roster.tryId || '')
            )
                continue
        } else if (!compiledOwnerMatches(rel.slice(0, slash))) {
            needsOwner = true
            continue
        }
        if (
            !roster.workspaceId ||
            !roster.chatflowId ||
            !companion.test(file) ||
            !/^[a-f0-9]{64}$/.test(row.sha256) ||
            book.files.has(file) ||
            book.files.size >= maxCompanions
        )
            throw Error('Unverified playbook companion.')
        const bytes = readBounded(path.join(base, rel), Math.min(maxBookBytes - book.bytes, 1024 * 1024 - total))
        total += bytes.length
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256 || bytes.includes(0)) throw Error('Invalid playbook companion.')
        book.files.set(file, new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'))
        book.bytes += bytes.length
    }
    return needsOwner
}

// Cache only the syntax of the same authored text. Manifest and owner checks stay live.
const parsedBooks = new WeakMap()

function playbookProfilePlan(books) {
    if (!books.length) return
    let preprocess = false
    const dependencies = books.map((book) => {
        let info = parsedBooks.get(book)
        if (!info || info.name !== book.name || info.description !== book.description || info.content !== book.content) {
            const markdown = playbookMarkdown(book)
            info = {
                name: book.name,
                description: book.description,
                content: book.content,
                preprocess: template.test(markdown) || inline.test(markdown),
                items: playbookDependencies(book)
            }
            if (book && typeof book === 'object') parsedBooks.set(book, info)
        }
        preprocess ||= info.preprocess
        return [book, info.items]
    })
    if (preprocess || process.env.CUTTLELY_HOST_FILE_MANIFEST || dependencies.some(([, items]) => items.relative.size))
        return { preprocess, dependencies }
}

export function needsNativePlaybookProfile(books) {
    return Boolean(playbookProfilePlan(books))
}

// Build a private snapshot solely from the admitted roster and immutable deployment declarations.
// No model argument chooses a principal, profile, manifest or host directory.
export function prepareNativePlaybooks(roster, specialist, chatId, turnId) {
    const books = specialist.playbooks || []
    const result = { gaps: [], assets: new Map(), templateVars: true, sessionId: null }
    const plan = playbookProfilePlan(books)
    if (!plan) return result
    const { preprocess, dependencies } = plan
    const host = publishedCanvasSource(roster) || roster
    const parent = host.tryId ? tryProfileName(host.tryId) : host.name
    if (!validId(parent) || typeof specialist.name !== 'string' || !specialist.name.trim()) {
        result.gaps.push('unverified playbook assignment')
        return result
    }
    const profile = specialistProfileName(parent, specialist.name)
    try {
        if (chatId && turnId) {
            const sessionProfile = roster.tryId ? specialistProfileName(tryProfileName(roster.tryId), specialist.name) : profile
            result.sessionId = specialistSessionId(sessionProfile, chatId, turnId)
        }
        for (const book of books) {
            if (validId(book.name)) result.assets.set(book.name, { files: new Map(), bytes: 0 })
        }
        if (preprocess) {
            const flags = effectiveSkillFlags(profile)
            result.templateVars = flags.templates
            if (flags.inlineShell && books.some((book) => inline.test(playbookMarkdown(book)))) result.gaps.push('playbook inline shell')
        }
        if (readManifestBooks(host, specialist, parent, profile, result.assets))
            result.gaps.push('playbook host manifest needs a canvas owner binding')
        if (
            dependencies.some(([book, items]) => {
                const files = result.assets.get(book.name)?.files || new Map()
                return (
                    (result.templateVars && items.templates.some((text) => needsAsset(text, files))) ||
                    [...items.relative].some((name) => !files.has(name))
                )
            })
        )
            result.gaps.push('unverified playbook file dependency')
    } catch {
        result.gaps.push('unverified playbook file or configuration')
    }
    return result
}

function virtualDirectory(book) {
    return rootPrefix() + book.name
}

function contentFor(book, state, file) {
    if (file === 'SKILL.md') return playbookMarkdown(book)
    return state?.assets.get(book.name)?.files.get(file)
}

// This virtual prefix is outside the managed writable workspace. A file grant can read the
// exact snapshot via its existing paginated, redacting file reader, with no host path access.
export function assignedPlaybookFile(books, state, requested) {
    if (typeof requested !== 'string' || !requested.startsWith(rootPrefix()) || state?.gaps.length) return null
    const parts = requested.slice(rootPrefix().length).split('/')
    const book = books.find((item) => item.name === parts[0])
    if (!book) return null
    const file = parts.slice(1).join('/')
    const text = contentFor(book, state, file)
    return typeof text === 'string' ? { path: file, content: text } : null
}

export const playbookTools = [
    {
        type: 'function',
        function: {
            name: 'skills_list',
            description: 'List the saved playbooks available to this specialist.',
            parameters: { type: 'object', properties: { category: { type: 'string' } }, additionalProperties: false }
        }
    },
    {
        type: 'function',
        function: {
            name: 'skill_view',
            description: 'Read a saved playbook. For long playbooks, pass next_offset as offset to read the next page.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    offset: { type: 'integer', minimum: 0, description: 'Offset returned by a previous page.' },
                    file_path: {
                        type: 'string',
                        description: 'Use a listed relative companion path or SKILL.md to read the saved file verbatim.'
                    }
                },
                required: ['name'],
                additionalProperties: false
            }
        }
    }
]

export function playbookCallLimit(playbooks, budget, state) {
    // Allow discovery, page reads and Calculator calls while bounding repeated model requests.
    const pages = playbooks.reduce((sum, book) => sum + 1 + (budget ? Math.ceil(JSON.stringify(book.content).length / budget) : 0), 0)
    let extra = 0
    for (const book of state?.assets.values() || [])
        for (const file of book.files.values()) extra += 1 + (budget ? Math.ceil(JSON.stringify(file).length / budget) : 0)
    return Math.min(128, pages + extra + 8)
}

// Resolve against this admitted specialist's roster. Even qualified names never become host paths.
export function readPlaybookTool(playbooks, tool, args, budget = 0, state) {
    if (state?.gaps.length) return { success: false, error: state.gaps.join(', ') }
    if (tool === 'skills_list') {
        const skills = (!args.category || args.category === PLAYBOOK_DIR ? playbooks : [])
            .map(({ name, description }) => ({ name, description, category: PLAYBOOK_DIR }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        return { success: true, skills, categories: skills.length ? [PLAYBOOK_DIR] : [], count: skills.length }
    }
    const book = playbooks.find(({ name }) => [name, PLAYBOOK_DIR + '/' + name, PLAYBOOK_DIR + ':' + name].includes(args.name))
    if (tool !== 'skill_view' || !book) return { success: false, error: 'This specialist has no such saved playbook or file.' }
    const dir = virtualDirectory(book)
    const requested = args.file_path || ''
    if (typeof requested !== 'string') return { success: false, error: 'Invalid playbook file.' }
    const file = requested.startsWith(dir + '/') ? requested.slice(dir.length + 1) : requested
    let markdown = contentFor(book, state, file || 'SKILL.md')
    if (typeof markdown !== 'string' || (requested && !file))
        return { success: false, error: 'This specialist has no such saved playbook or file.' }
    if (!requested && state?.templateVars)
        markdown = markdown.replace(/\$\{(HERMES_SKILL_DIR|HERMES_SESSION_ID)\}/g, (token, key) =>
            key === 'HERMES_SKILL_DIR' ? dir : state.sessionId || token
        )
    const groups = {}
    for (const name of state?.assets.get(book.name)?.files.keys() || []) {
        const group = groupOf(name)
        if (group) (groups[group] ||= []).push(name)
    }
    for (const values of Object.values(groups)) values.sort()
    const start = args.offset ?? 0
    if (!Number.isSafeInteger(start) || start < 0 || start > markdown.length)
        return { success: false, error: 'Invalid playbook page offset.' }
    // Size the encoded text the model actually receives. Leave room for the task and tool envelope.
    const pageChars = budget ? Math.max(2, Math.floor((budget * CHARS_PER_TOKEN) / 3)) : Infinity
    let end = Math.min(markdown.length, start + pageChars)
    while (end > start + 1 && JSON.stringify(markdown.slice(start, end)).length - 2 > pageChars) end = start + Math.floor((end - start) / 2)
    if (end < markdown.length && end > start + 1 && /[\uD800-\uDBFF]/.test(markdown[end - 1])) end--
    return {
        success: true,
        name: book.name,
        description: book.description,
        path: PLAYBOOK_DIR + '/' + book.name + '/' + (file || 'SKILL.md'),
        ...(!requested ? { skill_dir: dir } : {}),
        content: markdown.slice(start, end),
        ...(start || end < markdown.length ? { offset: start, next_offset: end < markdown.length ? end : null } : {}),
        tags: [],
        related_skills: [],
        linked_files: Object.keys(groups).length ? groups : null,
        ...(requested ? { name: args.name, file, file_type: path.posix.extname(file) } : {})
    }
}
