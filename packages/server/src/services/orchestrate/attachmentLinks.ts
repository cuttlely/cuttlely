// Made-up `attachment:` Markdown links: a model that knows a file exists but has no address for it writes one, and it
// opens nothing outside the Cuttlely chat. Orchestrate and A2A answers remove them, streamed or not.

/** Made-up `attachment:` links (the model naming a file it cannot link) are removed from the answer text. */
export function dropAttachmentLinks(text: string): string {
    return text.replace(/!?\[[^[\]\n]*\]\(\s*attachment:[^()[\]\n]*\)/gi, '').replace(/\n{3,}/g, '\n\n')
}

// Neither the label nor the target may hold a bracket, so every scan stops at the next `[`: filtering is linear in the
// text even for long runs of unmatched brackets.
const ATTACHMENT_LINK = /^!?\[[^[\]\n]*\]\(\s*attachment:[^()[\]\n]*\)/i
const HOLD_LIMIT = 2048

/** Could `rest` (which starts at `[` or `![`) still grow into an `attachment:` link? Scans up to the next `[` only. */
function mayBecomeAttachmentLink(rest: string): boolean {
    let i = rest.startsWith('!') ? 2 : 1
    for (; i < rest.length; i++) {
        const c = rest[i]
        if (c === ']') break
        if (c === '[' || c === '\n') return false
    }
    if (i >= rest.length) return rest.length <= HOLD_LIMIT // still in the label
    i++
    if (i >= rest.length) return true // label closed, `(` not seen yet
    if (rest[i] !== '(') return false
    i++
    while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++
    const start = i
    for (; i < rest.length; i++) {
        const c = rest[i]
        if (c === ')' || c === '(' || c === '[' || c === ']' || c === '\n') return false
    }
    const target = rest.slice(start, start + 11).toLowerCase()
    return rest.length <= HOLD_LIMIT && ('attachment:'.startsWith(target) || target === 'attachment:')
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
