// The local versions repo: a plain Git repo in the Cuttlely data dir.
// It needs no setup. Cuttlely runs the system git with fixed settings and never
// touches the user's own Git config, remotes, or credentials.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlowFiles, flowFolderName } from './serialize'
import { trailerLine } from './trailers'

export interface CommitInput {
    flowId: string
    name: string
    kind: VersionKind
    title: string
    details?: string[]
    author?: { name: string; email: string }
    // How many secret-looking values were hidden from this version.
    hidden?: number
    // Promote: the version from Dev this one copies.
    promotedFrom?: string
}

// publish: a draft copied to Live. rollback: Live set back to an earlier version. promote: a version from Dev put
// Live on Prod. All three are "Published" in history.
export type VersionKind = 'create' | 'save' | 'delete' | 'restore' | 'publish' | 'rollback' | 'promote'

export interface GitResult {
    stdout: string
    stderr: string
}

const README = `# Cuttlely version history

Cuttlely keeps every saved version of your flows here, one folder per flow.
It is a normal Git repo, managed by Cuttlely. Don't edit it while Cuttlely is running.
Secrets are never written here: credentials appear by name only.
`

const DEFAULT_AUTHOR = { name: 'Cuttlely', email: 'system@versions.local' }

export class GitMissingError extends Error {
    constructor() {
        super('git was not found on PATH. Version history is off until git is installed.')
    }
}

// The repo is always <cwd>/.git with <cwd> as the work tree. Inherited GIT_* variables are dropped,
// because a git hook (or a parent git process) exports GIT_DIR and GIT_INDEX_FILE, and those would
// point these commands at some other repository. Git never searches parent folders either.
// The user's global and system Git config are not read, so a global excludes file, hooks path, or
// signing setting cannot change what is committed. Commit identity is always passed in.
export function gitEnv(cwd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_')) env[key] = value
    }
    return {
        ...env,
        GIT_DIR: path.join(cwd, '.git'),
        GIT_WORK_TREE: cwd,
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        LC_ALL: 'C',
        ...extra
    }
}

export function runGit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', ...args],
            {
                cwd,
                env: gitEnv(cwd, env),
                maxBuffer: 64 * 1024 * 1024
            },
            (error, stdout, stderr) => {
                if (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitMissingError())
                    const message = String(stderr || error.message).trim()
                    return reject(new Error(`git ${args[0]} failed: ${message}`))
                }
                resolve({ stdout: String(stdout), stderr: String(stderr) })
            }
        )
    })
}

function readTree(dir: string, base = dir, out: FlowFiles = {}): FlowFiles {
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) readTree(full, base, out)
        else if (entry.isFile()) out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8')
    }
    return out
}

export class VersionStore {
    readonly dir: string
    private ready: Promise<void> | null = null

    constructor(dir: string) {
        this.dir = dir
    }

    flowsDir(): string {
        return path.join(this.dir, 'flows')
    }

    ensure(): Promise<void> {
        if (!this.ready) {
            this.ready = this.init().catch((error) => {
                this.ready = null
                throw error
            })
        }
        return this.ready
    }

    private async init(): Promise<void> {
        fs.mkdirSync(this.dir, { recursive: true })
        if (fs.existsSync(path.join(this.dir, '.git'))) return
        await runGit(this.dir, ['init', '-q'])
        await runGit(this.dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
        fs.writeFileSync(path.join(this.dir, 'README.md'), README)
        fs.mkdirSync(this.flowsDir(), { recursive: true })
        await runGit(this.dir, ['add', 'README.md'])
        await this.commitRaw('Start version history', DEFAULT_AUTHOR)
    }

    // The folder that holds this flow, found by the id in its flow.json so a rename is followed.
    findFolder(flowId: string): string | null {
        const flows = this.flowsDir()
        if (!fs.existsSync(flows)) return null
        const suffix = String(flowId).replace(/-/g, '')
        for (const entry of fs.readdirSync(flows, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const tail = entry.name.split('--').pop() || ''
            if (!suffix.startsWith(tail)) continue
            try {
                const flow = JSON.parse(fs.readFileSync(path.join(flows, entry.name, 'flow.json'), 'utf8'))
                if (flow?.id === flowId) return entry.name
            } catch {
                continue
            }
        }
        return null
    }

    readFlow(flowId: string): FlowFiles | null {
        const folder = this.findFolder(flowId)
        return folder ? readTree(path.join(this.flowsDir(), folder)) : null
    }

    private folderFor(flowId: string, name: string): string {
        const wanted = flowFolderName({ id: flowId, name })
        const taken = (folder: string) => {
            const file = path.join(this.flowsDir(), folder, 'flow.json')
            if (!fs.existsSync(file)) return false
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'))?.id !== flowId
            } catch {
                return true
            }
        }
        if (!taken(wanted)) return wanted
        return `${wanted.split('--')[0]}--${String(flowId).replace(/-/g, '')}`
    }

    // Replaces the flow's folder with these files. Returns the folder paths to stage.
    writeFlow(flowId: string, name: string, files: FlowFiles): string[] {
        const previous = this.findFolder(flowId)
        const folder = this.folderFor(flowId, name)
        const staged = new Set<string>([`flows/${folder}`])
        if (previous) {
            fs.rmSync(path.join(this.flowsDir(), previous), { recursive: true, force: true })
            staged.add(`flows/${previous}`)
        }
        const root = path.join(this.flowsDir(), folder)
        fs.rmSync(root, { recursive: true, force: true })
        for (const [file, content] of Object.entries(files)) {
            const target = path.join(root, ...file.split('/'))
            if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside the flow folder: ${file}`)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, content)
        }
        return [...staged]
    }

    removeFlow(flowId: string): string[] {
        const folder = this.findFolder(flowId)
        if (!folder) return []
        fs.rmSync(path.join(this.flowsDir(), folder), { recursive: true, force: true })
        return [`flows/${folder}`]
    }

    // Stages the paths and commits. Returns the new commit id, or null when nothing changed.
    async commit(paths: string[], input: CommitInput): Promise<string | null> {
        if (!paths.length) return null
        // --force: every file Cuttlely wrote belongs in the version, whatever an ignore rule says.
        await runGit(this.dir, ['add', '-A', '--force', '--', ...paths])
        const status = await runGit(this.dir, ['diff', '--cached', '--name-only'])
        if (!status.stdout.trim()) return null
        const body = (input.details || []).filter((line) => line && line !== input.title).join('\n')
        const trailers = [
            trailerLine('Flow', input.flowId),
            trailerLine('Kind', input.kind),
            trailerLine('Name', input.name.replace(/\n/g, ' ')),
            ...(input.hidden ? [trailerLine('Hidden', input.hidden)] : []),
            ...(input.promotedFrom && /^[0-9a-f]{40}$/.test(input.promotedFrom) ? [trailerLine('From', input.promotedFrom)] : [])
        ].join('\n')
        const message = body ? `${input.title}\n\n${body}\n\n${trailers}` : `${input.title}\n\n${trailers}`
        return this.commitRaw(message, input.author || DEFAULT_AUTHOR)
    }

    private async commitRaw(message: string, author: { name: string; email: string }): Promise<string> {
        const env = {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: DEFAULT_AUTHOR.name,
            GIT_COMMITTER_EMAIL: DEFAULT_AUTHOR.email
        }
        await runGit(this.dir, ['commit', '-q', '--no-verify', '-m', message], env)
        const head = await runGit(this.dir, ['rev-parse', 'HEAD'])
        return head.stdout.trim()
    }
}
