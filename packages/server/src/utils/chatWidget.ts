import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { getNodeModulesPackagePath } from '.'

export interface ChatWidgetScript {
    body: Buffer
    version: string
    etag: string
}

/** Where the built widget lives: the @cuttlely/chat workspace package (packages/chat-widget). */
export function chatWidgetPackageDir(): string {
    try {
        return path.dirname(require.resolve('@cuttlely/chat/package.json'))
    } catch {
        return getNodeModulesPackagePath('@cuttlely/chat')
    }
}

/** Reads dist/chat.js once. Null when the widget has not been built, so the route can say so. */
export function readChatWidgetScript(dir: string = chatWidgetPackageDir()): ChatWidgetScript | null {
    if (!dir) return null
    try {
        const body = fs.readFileSync(path.join(dir, 'dist', 'chat.js'))
        let version = 'dev'
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }
            if (typeof pkg.version === 'string') version = pkg.version
        } catch {
            // keep 'dev'
        }
        const etag = `"${version}-${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`
        return { body, version, etag }
    } catch {
        return null
    }
}

let cached: ChatWidgetScript | null | undefined

export function chatWidgetScript(): ChatWidgetScript | null {
    if (cached === undefined) cached = readChatWidgetScript()
    return cached
}
