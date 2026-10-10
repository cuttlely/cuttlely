// Second line of defense after renderMarkdown: walk the parsed fragment and drop any element or attribute
// that renderMarkdown would never write. If the renderer ever gains a bug, this still keeps scripts,
// event handlers and unsafe URLs out of the page.

import { safeUrl } from './markdown.js'

const ALLOWED = {
    A: ['href', 'target', 'rel'],
    BLOCKQUOTE: [],
    BR: [],
    BUTTON: ['type', 'class', 'data-copy-code', 'aria-label'],
    CODE: [],
    DEL: [],
    DIV: ['class'],
    EM: [],
    H1: [],
    H2: [],
    H3: [],
    H4: [],
    H5: [],
    H6: [],
    HR: [],
    IMG: ['src', 'alt', 'loading'],
    LI: [],
    OL: ['start'],
    P: [],
    PRE: [],
    SPAN: ['class', 'aria-hidden'],
    STRONG: [],
    TABLE: [],
    TBODY: [],
    TD: ['style'],
    TH: ['style'],
    THEAD: [],
    TR: [],
    UL: []
}

const SAFE_STYLE = /^text-align:(left|right|center)$/

export function scrub(root) {
    const walker = root.ownerDocument.createTreeWalker(root, 1 /* SHOW_ELEMENT */)
    const doomed = []
    let node = walker.nextNode()
    while (node) {
        const allowed = ALLOWED[node.tagName]
        if (!allowed) {
            doomed.push(node)
        } else {
            for (const attr of Array.from(node.attributes)) {
                const name = attr.name.toLowerCase()
                let keep = allowed.includes(name)
                if (keep && (name === 'href' || name === 'src')) keep = safeUrl(attr.value, { image: name === 'src' }) !== null
                if (keep && name === 'style') keep = SAFE_STYLE.test(attr.value)
                if (keep && name === 'target') keep = attr.value === '_blank'
                if (!keep) node.removeAttribute(attr.name)
            }
            if (node.tagName === 'A') node.setAttribute('rel', 'noopener noreferrer nofollow')
        }
        node = walker.nextNode()
    }
    for (const el of doomed) el.replaceWith(root.ownerDocument.createTextNode(el.textContent || ''))
    return root
}
