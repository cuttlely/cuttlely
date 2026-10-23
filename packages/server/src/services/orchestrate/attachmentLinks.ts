// Made-up `attachment:` Markdown links: a model that knows a file exists but has no address for it writes one, and it
// opens nothing outside the Cuttlely chat. Orchestrate and A2A answers remove them, streamed or not.

/** Made-up `attachment:` links (the model naming a file it cannot link) are removed from the answer text. */
export function dropAttachmentLinks(text: string): string {
    return text.replace(/!?\[[^\]\n]*\]\(\s*attachment:[^)\n]*\)/gi, '').replace(/\n{3,}/g, '\n\n')
}

const ATTACHMENT_LINK = /^!?\[[^\]\n]*\]\(\s*attachment:[^)\n]*\)/i
const HOLD_LIMIT = 2048

/** Could `rest` (which starts at `[` or `![`) still grow into an `attachment:` link? */
function mayBecomeAttachmentLink(rest: string): boolean {
    if (rest.length > HOLD_LIMIT) return false
    const m = rest.match(/^!?\[([^\]\n]*)(\](\(\s*([^)\n]*))?)?$/)
    if (!m) return false
    if (m[2] === undefined) return true // still in the label
    if (m[3] === undefined) return m[2] === ']' // label closed, `(` not seen yet
    const target = (m[4] ?? '').toLowerCase()
    return 'attachment:'.startsWith(target) || target.startsWith('attachment:')
}

/**
 * A streaming filter that removes `attachment:` Markdown links from token text. Text that may be the start of such a
 * link is held back (at most a couple of KB) until it is clearly not one; `flush` returns whatever is held.
 */
export function makeAttachmentLinkFilter(): { push(text: string): string; flush(): string } {
    let held = ''
    const drain = (final: boolean): string => {
        let out = ''
        let rest = held
        for (;;) {
            const i = rest.indexOf('[')
            if (i < 0) {
                // A trailing `!` may start an image link.
                if (!final && rest.endsWith('!')) {
                    out += rest.slice(0, -1)
                    rest = '!'
                } else {
                    out += rest
                    rest = ''
                }
                break
            }
            const start = i > 0 && rest[i - 1] === '!' ? i - 1 : i
            out += rest.slice(0, start)
            rest = rest.slice(start)
            const link = rest.match(ATTACHMENT_LINK)
            if (link) {
                rest = rest.slice(link[0].length)
                continue
            }
            if (!final && mayBecomeAttachmentLink(rest)) break
            const skip = rest.startsWith('!') ? 2 : 1
            out += rest.slice(0, skip)
            rest = rest.slice(skip)
        }
        held = rest
        return out
    }
    return {
        push: (text) => {
            held += text
            return drain(false)
        },
        flush: () => drain(true)
    }
}
