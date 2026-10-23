// Files an answer produced (Harness or tool artifacts kept in file storage) as Markdown links for callers that only
// read answer text: watsonx Orchestrate (/api/v1/orchestrate) and A2A. Each link is signed (fileLinkSignature.ts) for
// exactly this organization, flow, chat and file, so it opens without the flow's API key and only that one file.
// Only FILE-STORAGE artifacts with a plain file name are linked: no path parts, no traversal, no server paths in the
// output. The link lifetime comes from EXTERNAL_FILE_LINK_TTL_SECONDS (default 1 hour, bounded to 60 s .. 24 h).
import { Request } from 'express'
import { Workspace } from '../../database/entities/identity'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { a2aPublicOrigin } from '../a2a/agentCard'
import { fileDownloadUrl, signFileLink } from '../../utils/fileLinkSignature'
import { dropAttachmentLinks } from './attachmentLinks'

export { dropAttachmentLinks, makeAttachmentLinkFilter } from './attachmentLinks'

export const EXTERNAL_FILE_LINK_TTL_ENV = 'EXTERNAL_FILE_LINK_TTL_SECONDS'
export const EXTERNAL_FILE_LINK_TTL_DEFAULT = 60 * 60
export const EXTERNAL_FILE_LINK_TTL_MIN = 60
export const EXTERNAL_FILE_LINK_TTL_MAX = 24 * 60 * 60

const STORAGE_PREFIX = 'FILE-STORAGE::'
// A plain base name: no path separators, no control characters, no `%` (encoded separators), not starting with a dot or
// a space or `[` (a stored list of names); spaces and non-ASCII letters are fine (the URL encodes them).
// eslint-disable-next-line no-control-regex
const SAFE_FILE_NAME = /^[^\s.[/\\%\u0000-\u001f\u007f][^/\\%\u0000-\u001f\u007f]{0,254}$/
const IMAGE_TYPES = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp'])

/** The link lifetime in seconds: the env value when it is a whole number, clamped to [60, 86400]; else 3600. */
export function externalFileLinkTtlSeconds(raw: string | undefined = process.env[EXTERNAL_FILE_LINK_TTL_ENV]): number {
    const text = raw?.trim()
    if (!text || !/^\d{1,9}$/.test(text)) return EXTERNAL_FILE_LINK_TTL_DEFAULT
    return Math.min(EXTERNAL_FILE_LINK_TTL_MAX, Math.max(EXTERNAL_FILE_LINK_TTL_MIN, Number(text)))
}

export type FileLinkContext = {
    baseURL: string
    orgId: string
    chatflowId: string
    chatId: string
    ttlSeconds?: number
    now?: number
}

export type LinkedArtifact = { fileName: string; markdown: string }

/** The stored file name of one artifact, or undefined when it is not a plain FILE-STORAGE file name. */
export function storedFileName(artifact: unknown): string | undefined {
    if (!artifact || typeof artifact !== 'object') return undefined
    const data = (artifact as { data?: unknown }).data
    if (typeof data !== 'string' || !data.startsWith(STORAGE_PREFIX)) return undefined
    const name = data.slice(STORAGE_PREFIX.length)
    if (!SAFE_FILE_NAME.test(name) || name.includes('..')) return undefined
    return name
}

function isImage(artifact: { type?: unknown }, fileName: string): boolean {
    const type = typeof artifact.type === 'string' ? artifact.type.toLowerCase() : ''
    if (IMAGE_TYPES.has(type)) return true
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    return !type && IMAGE_TYPES.has(ext)
}

// Harness and tool files are stored as `harness_<specialist>_<ms>_<index>_<name>` (or `harness_python_...`); the
// link shows the name the file was written under.
function writtenName(fileName: string): string {
    const parts = fileName.split('_')
    if (parts[0] !== 'harness') return fileName
    for (let i = 2; i + 2 < parts.length; i++) {
        if (/^\d+$/.test(parts[i]) && /^\d+$/.test(parts[i + 1])) return parts.slice(i + 2).join('_') || fileName
    }
    return fileName
}

/** Link text: the artifact's own name when it has one, else the stored name; Markdown brackets and controls removed. */
function label(artifact: { name?: unknown }, fileName: string): string {
    const raw = typeof artifact.name === 'string' && artifact.name.trim() ? artifact.name : writtenName(fileName)
    const base = raw.split(/[\\/]/).pop() ?? ''
    const clean = base
        .replace(/[\u0000-\u001f\u007f[\]()<>`*\\!]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
    return clean || 'file'
}

/**
 * One Markdown line per linkable artifact: `![Image: name](url)` for images, `[Download name](url)` for other files.
 * Both labels start with a capital word on purpose. Console clients of these routes (the watsonx Orchestrate CLI prints
 * answers through Rich) read `[` + a lowercase letter, `#`, `/` or `@` up to `]` as a style tag and drop it, which
 * turned `![chart.png](url)` into `!(url)`, an image with no alt text that no Markdown renderer shows.
 */
export function artifactLinks(artifacts: unknown, ctx: FileLinkContext, skip?: Set<string>): LinkedArtifact[] {
    if (!Array.isArray(artifacts) || !ctx.baseURL || !ctx.orgId || !ctx.chatflowId || !ctx.chatId) return []
    const ttl = Math.min(EXTERNAL_FILE_LINK_TTL_MAX, Math.max(EXTERNAL_FILE_LINK_TTL_MIN, ctx.ttlSeconds ?? externalFileLinkTtlSeconds()))
    const now = ctx.now ?? Date.now()
    const out: LinkedArtifact[] = []
    const seen = new Set<string>()
    for (const artifact of artifacts) {
        const fileName = storedFileName(artifact)
        if (!fileName || seen.has(fileName) || skip?.has(fileName)) continue
        const target = { orgId: ctx.orgId, chatflowId: ctx.chatflowId, chatId: ctx.chatId, fileName }
        // Unsigned links need the flow's key, which these callers do not hold: leave the file out instead.
        if (!signFileLink(target, now, ttl)) continue
        seen.add(fileName)
        const image = isImage(artifact as { type?: unknown }, fileName)
        const url = new URL(fileDownloadUrl(ctx.baseURL, target, now, ttl))
        // An image is shown inline, so it must not be served as an attachment. `download` is not part of the signature.
        if (image) url.searchParams.delete('download')
        const name = label(artifact as { name?: unknown }, fileName)
        out.push({ fileName, markdown: image ? `![Image: ${name}](${url.toString()})` : `[Download ${name}](${url.toString()})` })
    }
    return out
}

/** The answer text with the file links after it. */
export function withArtifactLinks(text: string, links: LinkedArtifact[]): string {
    const clean = dropAttachmentLinks(text)
        .replace(/^(?:[ \t]*\n)+/, '')
        .trimEnd()
    if (!links.length) return clean
    const block = links.map((l) => l.markdown).join('\n\n')
    return clean ? `${clean}\n\n${block}` : block
}

/** Tracks which files a run already linked, so the streamed delta and the final body never repeat one. */
export type ArtifactLinker = {
    /** Markdown for artifacts not yet linked (empty string when none). */
    take(artifacts: unknown): string
    /** Notes files from a streamed artifacts frame; they are linked by the next `take`, `links` or `all`. */
    collect(artifacts: unknown): void
    links(artifacts: unknown): LinkedArtifact[]
    /** Every file linked so far plus any new ones in `artifacts`, for a body that replaces what was streamed. */
    all(artifacts: unknown): LinkedArtifact[]
}

export function makeArtifactLinker(ctx: FileLinkContext | undefined): ArtifactLinker {
    const linked = new Set<string>()
    const sent: LinkedArtifact[] = []
    let pending: unknown[] = []
    const links = (artifacts: unknown): LinkedArtifact[] => {
        const all = [...pending, ...(Array.isArray(artifacts) ? artifacts : [])]
        pending = []
        if (!ctx) return []
        const found = artifactLinks(all, ctx, linked)
        for (const l of found) {
            linked.add(l.fileName)
            sent.push(l)
        }
        return found
    }
    return {
        links,
        collect: (artifacts) => {
            if (Array.isArray(artifacts)) pending.push(...artifacts)
        },
        all: (artifacts) => {
            links(artifacts)
            return [...sent]
        },
        take: (artifacts) =>
            links(artifacts)
                .map((l) => l.markdown)
                .join('\n\n')
    }
}

/** The organization a flow belongs to (its workspace's organization), the one get-upload-file checks a link against. */
export async function flowOrgId(chatflow: { workspaceId?: string | null }): Promise<string | undefined> {
    if (!chatflow?.workspaceId) return undefined
    try {
        const workspace = await getRunningExpressApp().AppDataSource.getRepository(Workspace).findOneBy({ id: chatflow.workspaceId })
        return typeof workspace?.organizationId === 'string' && workspace.organizationId ? workspace.organizationId : undefined
    } catch {
        return undefined
    }
}

/** Link context for one external run: the public origin, the flow's organization, the flow and the run's chat. */
export async function fileLinkContext(
    req: Request,
    chatflow: { id: string; workspaceId?: string | null },
    chatId: string | undefined
): Promise<FileLinkContext | undefined> {
    if (!chatId) return undefined
    const orgId = await flowOrgId(chatflow)
    if (!orgId) return undefined
    let baseURL: string
    try {
        baseURL = a2aPublicOrigin(req)
    } catch {
        return undefined
    }
    return { baseURL, orgId, chatflowId: chatflow.id, chatId, ttlSeconds: externalFileLinkTtlSeconds() }
}

/** The artifacts a run result carries. */
export function resultArtifacts(result: unknown): unknown[] {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return []
    const artifacts = (result as { artifacts?: unknown }).artifacts
    return Array.isArray(artifacts) ? artifacts : []
}
