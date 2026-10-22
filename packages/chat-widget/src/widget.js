// The chat widget: one class that renders into a shadow root and drives a conversation with a Cuttlely flow.

import { createClient, describeError } from './api.js'
import { colorVariables, normalizeConfig } from './config.js'
import { icons, mark } from './icons.js'
import { renderMarkdown, safeUrl } from './markdown.js'
import { emptyRun, formatMs, reduceRun } from './run.js'
import { scrub } from './scrub.js'
import { styles } from './styles.js'

const STORAGE_PREFIX = 'cuttlely-chat:v1:'
const MAX_SAVED_MESSAGES = 60
const REPO_URL = 'https://github.com/cuttlely/cuttlely'

let uid = 0
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`

function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') el.className = value
        else if (key === 'text') el.textContent = value
        else if (key === 'html') el.innerHTML = value // only for icon strings written in icons.js
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
        else el.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue
        el.append(typeof child === 'string' ? document.createTextNode(child) : child)
    }
    return el
}

function markdownNode(text, base) {
    const tpl = document.createElement('template')
    tpl.innerHTML = renderMarkdown(text, { base })
    scrub(tpl.content)
    const div = h('div', { class: 'dc-md' })
    div.append(tpl.content)
    return div
}

function normalizeSources(data) {
    const list = Array.isArray(data) ? data : []
    const seen = new Set()
    const out = []
    for (const doc of list) {
        if (!doc || typeof doc !== 'object') continue
        const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}
        const url = safeUrl(typeof meta.url === 'string' ? meta.url : typeof meta.source === 'string' ? meta.source : '')
        const rawTitle = meta.title || meta.source || meta.url || meta.name || doc.title || ''
        const title = String(rawTitle || 'Source')
            .split(/[\\/]/)
            .filter(Boolean)
            .pop()
            .slice(0, 120)
        const key = `${url || ''}|${title}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ title: title || 'Source', url, excerpt: typeof doc.pageContent === 'string' ? doc.pageContent.slice(0, 600) : '' })
        if (out.length >= 8) break
    }
    return out
}

function normalizeArtifacts(data) {
    const list = Array.isArray(data) ? data : []
    return list
        .filter((item) => item && typeof item === 'object' && typeof item.data === 'string')
        .map((item) => ({
            type: String(item.type || ''),
            data: item.data,
            ...(typeof item.name === 'string' && item.name ? { name: item.name.slice(0, 200) } : {})
        }))
        .slice(0, 8)
}

// Files a harness specialist made (PDF, DOCX, XLSX, CSV) are offered as downloads from the chat's file storage.
export const FILE_ARTIFACT_TYPES = ['pdf', 'docx', 'xlsx', 'csv']

// The name to save as: the artifact's own name, or the stored file name without the harness_<specialist>_<time>_<n>_ prefix.
export function fileArtifactName(item) {
    const named = typeof item?.name === 'string' ? item.name : ''
    const stored = String(item?.data || '')
        .replace(/^FILE-STORAGE::/, '')
        .replace(/^harness_[A-Za-z0-9_-]*?_\d+_\d+_/, '')
    const name = (named || stored)
        .split('/')
        .pop()
        .replace(/[^A-Za-z0-9._-]/g, '_')
    return name || `file.${item?.type || 'bin'}`
}

function parseFollowUps(value) {
    let list = value
    for (let i = 0; i < 2 && typeof list === 'string'; i++) {
        try {
            list = JSON.parse(list)
        } catch {
            return []
        }
    }
    return Array.isArray(list)
        ? list
              .filter((item) => typeof item === 'string' && item.trim())
              .map((item) => item.trim().slice(0, 200))
              .slice(0, 4)
        : []
}

function lastAgentflowText(data) {
    if (!Array.isArray(data)) return ''
    for (let i = data.length - 1; i >= 0; i--) {
        const content = data[i]?.data?.output?.content
        if (typeof content === 'string' && content.trim()) return content
    }
    return ''
}

export class ChatWidget {
    /**
     * @param {HTMLElement} host element that gets the shadow root
     * @param {object} options flowId, apiHost, mode ('bubble' | 'page'), theme ('auto' | 'light' | 'dark'), open,
     *   config (share-setting overrides), overrideConfig, blocked ('private' | 'missing' | 'origin'), storage, fetch
     */
    constructor(host, options = {}) {
        this.host = host
        this.options = { mode: 'bubble', theme: 'auto', storage: true, ...options }
        this.mode = this.options.mode === 'page' ? 'page' : 'bubble'
        this.api = createClient({
            apiHost: this.options.apiHost || location.origin,
            flowId: this.options.flowId,
            fetchImpl: this.options.fetch
        })
        this.base = this.api.host
        this.config = normalizeConfig({}, this.options.config)
        this.messages = []
        this.pending = []
        this.chatId = ''
        this.sessionToken = ''
        this.busy = false
        this.state = 'loading'
        this.blocked = null
        this.isOpen = this.mode === 'page' || Boolean(this.options.open)
        this.nodes = new Map()
        this.frame = 0
        this.root = host.shadowRoot || host.attachShadow({ mode: 'open' })
        this.panelId = nextId('dc-panel')
        this.build()
        this.applyTheme()
        if (this.options.blocked)
            this.block({ kind: this.options.blocked, message: describeError({ status: this.blockedStatus(this.options.blocked) }).message })
        else this.load()
    }

    blockedStatus(kind) {
        return { private: 401, origin: 403, missing: 404 }[kind] || 500
    }

    // ------------------------------------------------------------ setup

    build() {
        this.root.innerHTML = ''
        const style = h('style', { text: styles })
        this.wrap = h('div', { class: `dc ${this.mode === 'page' ? 'dc-page' : 'dc-bubble'}` })
        this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' })
        this.window = h('section', {
            class: `dc-window${this.mode === 'bubble' ? ' dc-panel' : ''}`,
            id: this.panelId,
            role: this.mode === 'bubble' ? 'dialog' : 'region',
            'aria-label': 'Chat'
        })
        this.window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.mode === 'bubble') {
                event.stopPropagation()
                this.close(true)
            }
        })
        this.wrap.append(this.window, this.live)
        if (this.mode === 'bubble') {
            this.launcher = h('button', {
                class: 'dc-launcher',
                type: 'button',
                'aria-label': 'Open chat',
                'aria-controls': this.panelId,
                'aria-expanded': 'false',
                html: icons.chat,
                onclick: () => this.toggle()
            })
            this.wrap.append(this.launcher)
            this.window.hidden = !this.isOpen
        }
        this.root.append(style, this.wrap)
        this.renderShell()
    }

    applyTheme() {
        const theme = this.options.theme
        const set = (dark) => this.wrap.classList.toggle('dark', dark)
        this.media?.removeEventListener?.('change', this.onMedia)
        if (theme === 'dark' || theme === 'light') return set(theme === 'dark')
        this.media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
        this.onMedia = () => set(Boolean(this.media?.matches))
        this.onMedia()
        this.media?.addEventListener?.('change', this.onMedia)
    }

    setTheme(theme) {
        this.options.theme = theme
        this.applyTheme()
    }

    applyConfigStyles() {
        const vars = colorVariables(this.config.colors)
        const size = this.config.fontSize ? `--dc-size:${this.config.fontSize}px;` : ''
        this.wrap.setAttribute('style', vars + size)
        this.wrap.classList.toggle('has-bot-bg', Boolean(this.config.colors.botBg))
        this.window.setAttribute('aria-label', this.config.title || 'Chat')
    }

    async load() {
        this.state = 'loading'
        this.renderShell()
        try {
            const raw = await this.api.loadConfig()
            this.config = normalizeConfig(raw, this.options.config)
            this.state = 'ready'
            this.restore()
        } catch (error) {
            const info = describeError(error)
            // A flow that can't be found answers 404 or 500 here; both mean there is nothing to chat with.
            this.block(info.kind === 'error' ? { kind: 'missing', message: 'This chat could not be found.' } : info)
            return
        }
        this.applyConfigStyles()
        this.renderShell()
        this.options.onReady?.(this)
    }

    block(info) {
        this.state = 'blocked'
        this.blocked = info
        this.abort()
        this.renderShell()
        this.announce(info.message)
    }

    // ------------------------------------------------------------ storage

    storageKey() {
        return `${STORAGE_PREFIX}${this.base}:${this.options.flowId}`
    }

    restore() {
        if (!this.options.storage || this.config.newSessionEachVisit) return
        try {
            const saved = JSON.parse(localStorage.getItem(this.storageKey()) || 'null')
            if (!saved || typeof saved !== 'object') return
            this.chatId = typeof saved.chatId === 'string' ? saved.chatId : ''
            this.sessionToken = typeof saved.sessionToken === 'string' ? saved.sessionToken : ''
            const list = Array.isArray(saved.messages) ? saved.messages : []
            this.messages = list
                .filter((msg) => msg && (msg.role === 'user' || msg.role === 'bot') && typeof msg.text === 'string')
                .map((msg) => ({
                    id: nextId('m'),
                    role: msg.role,
                    text: msg.text,
                    images: Array.isArray(msg.images) ? msg.images.filter((src) => safeUrl(src, { image: true })) : [],
                    sources: Array.isArray(msg.sources) ? msg.sources : [],
                    artifacts: normalizeArtifacts(msg.artifacts),
                    run: msg.run && typeof msg.run === 'object' ? msg.run : null,
                    messageId: typeof msg.messageId === 'string' ? msg.messageId : '',
                    feedback: msg.feedback === 'up' || msg.feedback === 'down' ? msg.feedback : null,
                    status: 'done',
                    rev: 0
                }))
        } catch {
            // Storage blocked or corrupt: start fresh.
        }
    }

    save() {
        if (!this.options.storage) return
        try {
            const messages = this.messages
                .filter((msg) => msg.status === 'done' && !msg.error)
                .slice(-MAX_SAVED_MESSAGES)
                .map((msg) => ({
                    role: msg.role,
                    text: msg.text,
                    images: (msg.images || []).filter((src) => src.length < 150000),
                    sources: msg.sources || [],
                    artifacts: msg.artifacts || [],
                    run: msg.run || null,
                    messageId: msg.messageId || '',
                    feedback: msg.feedback || null
                }))
            localStorage.setItem(this.storageKey(), JSON.stringify({ chatId: this.chatId, sessionToken: this.sessionToken, messages }))
        } catch {
            // Quota or privacy mode: the chat still works, it just won't survive a reload.
        }
    }

    reset() {
        this.abort()
        this.messages = []
        this.pending = []
        this.chatId = ''
        this.sessionToken = ''
        this.nodes.clear()
        try {
            localStorage.removeItem(this.storageKey())
        } catch {
            // ignore
        }
        this.renderShell()
        this.announce('Started a new chat')
        this.focusInput()
    }

    // ------------------------------------------------------------ open / close (bubble)

    open() {
        if (this.mode !== 'bubble') return
        this.isOpen = true
        this.window.hidden = false
        this.launcher.setAttribute('aria-expanded', 'true')
        this.launcher.setAttribute('aria-label', 'Close chat')
        this.launcher.innerHTML = icons.close
        this.launcher.classList.add('is-open')
        this.scrollToEnd(true)
        this.focusInput()
    }

    close(returnFocus) {
        if (this.mode !== 'bubble') return
        this.isOpen = false
        this.window.hidden = true
        this.launcher.setAttribute('aria-expanded', 'false')
        this.launcher.setAttribute('aria-label', 'Open chat')
        this.launcher.innerHTML = icons.chat
        this.launcher.classList.remove('is-open')
        if (returnFocus) this.launcher.focus()
    }

    toggle() {
        if (this.isOpen) this.close(true)
        else this.open()
    }

    focusInput() {
        setTimeout(() => this.input?.focus(), 30)
    }

    announce(text) {
        this.live.textContent = ''
        setTimeout(() => {
            this.live.textContent = text
        }, 50)
    }

    // ------------------------------------------------------------ rendering

    renderShell() {
        this.window.innerHTML = ''
        this.nodes.clear()
        this.window.append(this.renderHeader())
        if (this.state === 'loading') {
            this.window.append(
                h('div', { class: 'dc-loading', role: 'status' }, [
                    h('div', { class: 'dc-typing', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]),
                    h('span', { class: 'sr-only', text: 'Loading chat' })
                ])
            )
            return
        }
        if (this.state === 'blocked') {
            this.window.append(this.renderNotice())
            return
        }
        this.scroller = h('div', { class: 'dc-scroll' })
        this.stick = true
        this.scroller.addEventListener('scroll', () => {
            this.stick = this.nearBottom()
        })
        this.thread = h('div', { class: 'dc-thread' })
        this.scroller.append(this.thread)
        this.window.append(this.scroller, this.renderComposer())
        this.renderThread()
        this.scrollToEnd(true)
    }

    renderHeader() {
        const cfg = this.config
        const brand = h('div', { class: 'dc-brand' })
        if (cfg.avatar) brand.append(h('img', { src: cfg.avatar, alt: '' }))
        else brand.innerHTML = mark
        const status = this.busy ? 'Answering' : this.state === 'blocked' ? 'Unavailable' : 'Ready'
        this.statusEl = h('div', { class: this.statusClass() }, [
            h('span', { class: 'dc-dot', 'aria-hidden': 'true' }),
            h('span', { text: status })
        ])
        const actions = []
        if (this.state === 'ready' && this.messages.length) {
            actions.push(
                h('button', {
                    class: 'dc-icon-btn',
                    type: 'button',
                    'aria-label': 'Start a new chat',
                    title: 'New chat',
                    html: icons.refresh,
                    onclick: () => this.reset()
                })
            )
        }
        if (this.mode === 'bubble') {
            actions.push(
                h('button', {
                    class: 'dc-icon-btn',
                    type: 'button',
                    'aria-label': 'Close chat',
                    title: 'Close',
                    html: icons.close,
                    onclick: () => this.close(true)
                })
            )
        }
        return h('header', { class: 'dc-header' }, [
            brand,
            h('div', { class: 'dc-titles' }, [h('h1', { class: 'dc-title', text: cfg.title || 'Chat' }), this.statusEl]),
            ...actions
        ])
    }

    updateStatus() {
        if (!this.statusEl) return
        this.statusEl.className = this.statusClass()
        this.statusEl.lastChild.textContent = this.busy ? 'Answering' : this.state === 'blocked' ? 'Unavailable' : 'Ready'
    }

    statusClass() {
        return `dc-status${this.busy ? ' dc-busy' : this.state === 'blocked' ? ' dc-off' : ''}`
    }

    renderNotice() {
        const info = this.blocked || {}
        const copy = {
            private: [
                'This chat is private',
                'This chat is private or needs a key. Ask the person who shared it for a public link.',
                icons.lock
            ],
            origin: ['Not available here', 'This chat is not available on this site.', icons.lock],
            missing: ['Chat not found', 'This chat could not be found. The link may be old or the chat may have been removed.', icons.alert]
        }[info.kind] || ['Chat unavailable', info.message || 'Something went wrong.', icons.alert]
        return h('div', { class: 'dc-notice' }, [
            h('div', { class: 'dc-notice-card' }, [
                h('div', { class: 'dc-notice-icon', html: copy[2] }),
                h('h2', { text: copy[0] }),
                h('p', { text: copy[1] })
            ])
        ])
    }

    renderWelcome() {
        const cfg = this.config
        const markEl = h('div', { class: 'dc-welcome-mark' })
        if (cfg.avatar) markEl.append(h('img', { src: cfg.avatar, alt: '' }))
        else markEl.innerHTML = mark
        const prompts = cfg.starterPrompts.length
            ? h(
                  'div',
                  { class: 'dc-prompts', role: 'list', 'aria-label': 'Suggested questions' },
                  cfg.starterPrompts.map((prompt) =>
                      h('div', { role: 'listitem' }, [
                          h('button', { class: 'dc-prompt', type: 'button', text: prompt, onclick: () => this.send(prompt) })
                      ])
                  )
              )
            : null
        return h('div', { class: 'dc-welcome' }, [
            markEl,
            h('h2', { text: cfg.title ? `Ask ${cfg.title}` : 'How can I help?' }),
            h('p', { text: cfg.welcome || 'Ask a question to get started.' }),
            prompts
        ])
    }

    renderThread() {
        if (!this.thread) return
        const wanted = []
        if (!this.messages.length) {
            this.thread.replaceChildren(this.renderWelcome())
            this.nodes.clear()
            return
        }
        const last = this.messages[this.messages.length - 1]
        for (const msg of this.messages) {
            const key = `${msg.id}:${msg.rev}:${msg === last ? 'last' : ''}`
            let node = this.nodes.get(msg.id)
            if (!node || node.dataset.key !== key) {
                node = msg.role === 'user' ? this.renderUser(msg) : this.renderBot(msg, msg === last)
                node.dataset.key = key
                this.nodes.set(msg.id, node)
            }
            wanted.push(node)
        }
        const current = Array.from(this.thread.children)
        if (current.length !== wanted.length || current.some((node, index) => node !== wanted[index]))
            this.thread.replaceChildren(...wanted)
    }

    renderUser(msg) {
        const body = h('div', { class: 'dc-body' })
        if (msg.images?.length)
            body.append(
                h(
                    'div',
                    { class: 'dc-thumbs' },
                    msg.images.map((src) => h('img', { src, alt: 'Attached image' }))
                )
            )
        if (msg.files?.length)
            body.append(
                h(
                    'div',
                    { class: 'dc-thumbs' },
                    msg.files.map((name) => h('span', { class: 'dc-file-chip', html: icons.doc }, [name]))
                )
            )
        if (msg.text) body.append(h('div', { class: 'dc-user-bubble', text: msg.text }))
        return h('div', { class: 'dc-msg user', 'data-id': msg.id }, [h('span', { class: 'sr-only', text: 'You said:' }), body])
    }

    renderBot(msg, isLast) {
        const cfg = this.config
        const avatar = h('div', { class: 'dc-avatar' })
        if (cfg.botAvatar || cfg.avatar) avatar.append(h('img', { src: cfg.botAvatar || cfg.avatar, alt: '' }))
        else avatar.innerHTML = mark
        const body = h('div', { class: 'dc-body' })
        if (msg.run) body.append(this.renderRun(msg.run, msg.status === 'streaming'))
        const bubble = h('div', { class: 'dc-bot-bubble' })
        if (msg.text) {
            const md = markdownNode(msg.text, this.base)
            if (msg.status === 'streaming') md.classList.add('dc-caret')
            bubble.append(md)
        } else if (msg.status === 'streaming') {
            bubble.append(h('div', { class: 'dc-typing', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]))
        }
        if (bubble.childNodes.length) body.append(bubble)
        if (msg.artifacts?.length) body.append(this.renderArtifacts(msg.artifacts))
        if (msg.sources?.length) body.append(this.renderSources(msg.sources))
        if (msg.error) body.append(this.renderError(msg, isLast))
        if (msg.action && isLast && msg.status === 'done') body.append(this.renderAction(msg))
        if (msg.status === 'done' && msg.text) body.append(this.renderTools(msg))
        if (isLast && msg.status === 'done' && msg.followUps?.length && !this.busy) {
            body.append(
                h(
                    'div',
                    { class: 'dc-followups', role: 'group', 'aria-label': 'Suggested follow-ups' },
                    msg.followUps.map((text) => h('button', { class: 'dc-chip', type: 'button', text, onclick: () => this.send(text) }))
                )
            )
        }
        return h('div', { class: 'dc-msg bot', 'data-id': msg.id }, [
            avatar,
            h('span', { class: 'sr-only', text: 'Assistant said:' }),
            body
        ])
    }

    renderRun(run, live) {
        const done = run.phase === 'done'
        const count = run.specialists.length
        const label =
            {
                planning: 'Planning the work',
                working: 'Specialists working',
                writing: 'Writing the answer',
                done: 'Run complete',
                failed: 'Run stopped'
            }[run.phase] || 'Working'
        const meta =
            done && run.totalMs
                ? `${count ? `${count} specialist${count === 1 ? '' : 's'} \u00b7 ` : ''}${formatMs(run.totalMs)}`
                : live
                ? 'Working\u2026'
                : ''
        const details = h('details', { class: 'dc-run' })
        if (!done && live) details.open = true
        const summary = h('summary', {}, [
            h('span', { class: 'dc-run-icon', html: icons.spark }),
            h('span', { class: 'dc-run-title', text: label }),
            h('span', { class: 'dc-run-meta', text: meta }),
            h('span', { class: 'dc-run-chev', 'aria-hidden': 'true', text: '\u203a' })
        ])
        details.append(summary)
        if (count) {
            details.append(
                h(
                    'ol',
                    { 'aria-label': 'Run steps' },
                    run.specialists.map((item) =>
                        h('li', { class: item.status }, [
                            h('span', { class: 'dc-step-dot', 'aria-hidden': 'true' }),
                            h('span', { text: item.name }),
                            h('span', { class: 'sr-only', text: `, ${item.status}` }),
                            item.ms ? h('em', { text: formatMs(item.ms) }) : null
                        ])
                    )
                )
            )
        }
        return details
    }

    renderArtifacts(list) {
        const wrap = h('div', { class: 'dc-artifacts' })
        for (const item of list) {
            if (item.type === 'png' || item.type === 'jpeg' || item.type === 'jpg' || item.type === 'gif' || item.type === 'webp') {
                wrap.append(this.renderImageArtifact(item))
            } else if (FILE_ARTIFACT_TYPES.includes(item.type) && item.data.startsWith('FILE-STORAGE::')) {
                wrap.append(this.renderFileArtifact(item))
            } else if (FILE_ARTIFACT_TYPES.includes(item.type)) {
                // A file is only offered from this chat's file storage; anything else is not shown.
                continue
            } else if (item.type === 'html') {
                // No scripts, forms or same-origin access: the sandbox has no allow tokens at all.
                const frame = h('iframe', { class: 'dc-html-frame', sandbox: '', title: 'Answer content', loading: 'lazy' })
                frame.srcdoc = item.data
                wrap.append(frame)
            } else if (item.data) {
                wrap.append(markdownNode(item.data, this.base))
            }
        }
        return wrap
    }

    renderFileArtifact(item) {
        return this.renderDownloadLink(item, fileArtifactName(item), item.type.toUpperCase())
    }

    // A download link for a stored file or image (FILE-STORAGE::name), or for an image already given as a data URL.
    renderDownloadLink(item, name, label, extraClass = '') {
        const stored = !item.data.startsWith('data:')
        const href = () => (stored ? `${this.api.fileUrl(this.chatId, item.data)}&download=true` : item.data)
        const link = h('a', { class: `dc-file${extraClass}`, href: href(), download: name, rel: 'noopener', title: `Download ${name}` }, [
            h('span', { class: 'dc-file-type', text: label }),
            h('span', { class: 'dc-file-name', text: name })
        ])
        link.addEventListener('click', async (event) => {
            // A plain link can't carry the session token, so with a token the file is read with it, for the chat id
            // known now, and saved from the blob.
            if (!stored || !this.sessionToken || !this.chatId) {
                link.href = href()
                return
            }
            event.preventDefault()
            try {
                const blob = await this.api.fileBlob(href(), this.sessionToken)
                const url = URL.createObjectURL(blob)
                const save = h('a', { href: url, download: name })
                save.click()
                setTimeout(() => URL.revokeObjectURL(url), 30000)
            } catch {
                link.replaceWith(h('div', { class: 'dc-figure-missing', html: icons.alert }, [`${name} could not be downloaded here.`]))
            }
        })
        return link
    }

    // The name to save an image as, with the extension of its type.
    imageArtifactName(item) {
        const name = fileArtifactName(item)
        const ext = item.type === 'jpeg' ? 'jpg' : item.type
        const known = ext === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${ext}$`, 'i')
        return known.test(name) ? name : `${name.replace(/\.[^.]*$/, '') || 'image'}.${ext}`
    }

    renderImageArtifact(item) {
        const direct = safeUrl(item.data, { image: true, base: this.base })
        const src = direct && !item.data.startsWith('/') ? direct : this.api.fileUrl(this.chatId, item.data)
        const figure = h('figure', { class: 'dc-figure' })
        const img = h('img', { src, alt: 'Chart from the answer', loading: 'lazy' })
        img.addEventListener('load', () => {
            if (this.stick) this.scrollToEnd()
        })
        let retried = false
        img.addEventListener('error', async () => {
            // A plain image request can't carry the session token (and the first answer's chart is drawn before the
            // chat id arrives), so read the file once with the token, for the chat id known now.
            if (!retried && !direct && this.sessionToken && this.chatId) {
                retried = true
                try {
                    const blob = await this.api.fileBlob(this.api.fileUrl(this.chatId, item.data), this.sessionToken)
                    img.src = URL.createObjectURL(blob)
                    return
                } catch {
                    // fall through to the placeholder
                }
            }
            figure.replaceChildren(h('div', { class: 'dc-figure-missing', html: icons.image }, ['This chart could not be shown here.']))
        })
        figure.append(img)
        // Stored images and data URLs get a download link under the picture; a link to another site does not.
        const mime = item.type === 'jpg' ? 'jpeg' : item.type
        const dataUrl = new RegExp(`^data:image/${mime};base64,[A-Za-z0-9+/]+={0,2}$`).test(item.data)
        if (src !== direct || dataUrl) {
            const name = this.imageArtifactName(item)
            const label = (item.type === 'jpeg' ? 'jpg' : item.type).toUpperCase()
            figure.append(this.renderDownloadLink(item, name, label, ' dc-image-download'))
        }
        return figure
    }

    renderSources(sources) {
        const wrap = h('div', { class: 'dc-sources-wrap' })
        const row = h('div', { class: 'dc-sources', role: 'list', 'aria-label': 'Sources' }, [
            h('span', { class: 'dc-sources-label', 'aria-hidden': 'true', text: 'Sources' })
        ])
        let preview = null
        sources.forEach((source, index) => {
            const content = [h('b', { text: String(index + 1) }), h('span', { text: source.title })]
            let chip
            if (source.url) {
                chip = h(
                    'a',
                    { class: 'dc-source', href: source.url, target: '_blank', rel: 'noopener noreferrer nofollow', title: source.title },
                    content
                )
            } else {
                chip = h('button', { class: 'dc-source', type: 'button', title: source.title, 'aria-expanded': 'false' }, content)
                chip.addEventListener('click', () => {
                    const opening = chip.getAttribute('aria-expanded') !== 'true'
                    row.querySelectorAll('button.dc-source').forEach((other) => other.setAttribute('aria-expanded', 'false'))
                    preview?.remove()
                    preview = null
                    if (opening && source.excerpt) {
                        chip.setAttribute('aria-expanded', 'true')
                        preview = h('div', { class: 'dc-source-preview', text: source.excerpt })
                        wrap.append(preview)
                    }
                })
            }
            row.append(h('div', { role: 'listitem', style: 'display:contents' }, [chip]))
        })
        wrap.append(row)
        return wrap
    }

    renderError(msg, isLast) {
        const children = [h('div', { text: msg.error })]
        if (isLast && msg.retry)
            children.push(h('button', { class: 'dc-chip', type: 'button', text: 'Try again', onclick: () => this.retry(msg) }))
        return h('div', { class: 'dc-error', role: 'alert' }, [h('span', { html: icons.alert }), h('div', {}, children)])
    }

    renderAction(msg) {
        const elements = Array.isArray(msg.action?.elements) ? msg.action.elements : []
        return h(
            'div',
            { class: 'dc-followups', role: 'group', 'aria-label': 'Choose an option' },
            elements
                .filter((el) => el && typeof el.label === 'string')
                .map((el, index) =>
                    h('button', {
                        class: `dc-chip${index === 0 ? ' primary' : ''}`,
                        type: 'button',
                        text: el.label,
                        onclick: () => this.chooseAction(msg, el)
                    })
                )
        )
    }

    renderTools(msg) {
        const copy = h('button', { class: 'dc-tool', type: 'button', 'aria-label': 'Copy answer', title: 'Copy', html: icons.copy })
        copy.addEventListener('click', () => this.copy(msg.text, copy))
        const tools = [copy]
        if (this.config.feedback && msg.messageId) {
            for (const [value, icon, label] of [
                ['up', icons.up, 'Good answer'],
                ['down', icons.down, 'Bad answer']
            ]) {
                tools.push(
                    h('button', {
                        class: 'dc-tool',
                        type: 'button',
                        'aria-label': label,
                        title: label,
                        'aria-pressed': msg.feedback === value ? 'true' : 'false',
                        html: icon,
                        onclick: () => this.rate(msg, value)
                    })
                )
            }
        }
        return h('div', { class: 'dc-tools' }, tools)
    }

    renderComposer() {
        const img = this.config.imageUpload
        this.pendingEl = h('div', { class: 'dc-pending', hidden: true })
        this.input = h('textarea', {
            rows: '1',
            'aria-label': 'Message',
            placeholder: this.config.placeholder || 'Ask a question\u2026',
            maxlength: '8000'
        })
        this.input.addEventListener('input', () => this.autosize())
        this.input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                this.send()
            }
        })
        const parts = []
        if (img) {
            this.fileInput = h('input', {
                type: 'file',
                accept: img.types.join(','),
                multiple: true,
                hidden: true,
                tabindex: '-1',
                'aria-hidden': 'true'
            })
            this.fileInput.addEventListener('change', () => {
                this.addFiles(this.fileInput.files)
                this.fileInput.value = ''
            })
            parts.push(
                this.fileInput,
                h('button', {
                    class: 'dc-attach',
                    type: 'button',
                    'aria-label': 'Attach an image',
                    title: 'Attach an image',
                    html: icons.attach,
                    onclick: () => this.fileInput.click()
                })
            )
            this.input.addEventListener('paste', (event) => {
                const files = Array.from(event.clipboardData?.files || [])
                if (files.length) {
                    event.preventDefault()
                    this.addFiles(files)
                }
            })
            this.window.addEventListener('dragover', (event) => {
                event.preventDefault()
                if (!this.dropEl) {
                    this.dropEl = h('div', { class: 'dc-drop', text: 'Drop an image to attach' })
                    this.window.append(this.dropEl)
                }
            })
            this.window.addEventListener('dragleave', (event) => {
                if (event.target === this.dropEl) this.clearDrop()
            })
            this.window.addEventListener('drop', (event) => {
                event.preventDefault()
                this.clearDrop()
                this.addFiles(event.dataTransfer?.files || [])
            })
        }
        this.sendBtn = h('button', { class: 'dc-send', type: 'button' })
        this.sendBtn.addEventListener('click', () => (this.busy ? this.abort(true) : this.send()))
        parts.push(this.input, this.sendBtn)
        this.updateSendButton()
        const foot = h('div', { class: 'dc-foot' }, [
            'Built with ',
            h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Cuttlely' })
        ])
        return h('div', { class: 'dc-composer' }, [
            h('div', { class: 'dc-compose-inner' }, [this.pendingEl, h('div', { class: 'dc-box' }, parts), foot])
        ])
    }

    clearDrop() {
        this.dropEl?.remove()
        this.dropEl = null
    }

    updateSendButton() {
        if (!this.sendBtn) return
        this.sendBtn.innerHTML = this.busy ? icons.stop : icons.send
        this.sendBtn.setAttribute('aria-label', this.busy ? 'Stop the answer' : 'Send message')
        this.sendBtn.title = this.busy ? 'Stop' : 'Send'
    }

    autosize() {
        const el = this.input
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    }

    renderPending() {
        if (!this.pendingEl) return
        this.pendingEl.hidden = !this.pending.length
        this.pendingEl.replaceChildren(
            ...this.pending.map((item, index) =>
                h('div', { class: 'dc-pending-item' }, [
                    h('img', { src: item.data, alt: item.name }),
                    h('button', {
                        type: 'button',
                        'aria-label': `Remove ${item.name}`,
                        html: icons.close,
                        onclick: () => {
                            this.pending.splice(index, 1)
                            this.renderPending()
                            this.focusInput()
                        }
                    })
                ])
            )
        )
    }

    async addFiles(fileList) {
        const img = this.config.imageUpload
        if (!img) return
        for (const file of Array.from(fileList || [])) {
            if (this.pending.length >= 4) break
            if (!img.types.includes(file.type)) {
                this.announce(`${file.name} is not an image this chat accepts.`)
                continue
            }
            if (file.size > img.maxMB * 1024 * 1024) {
                this.announce(`${file.name} is larger than ${img.maxMB} MB.`)
                continue
            }
            const data = await new Promise((resolve) => {
                const reader = new FileReader()
                reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
                reader.onerror = () => resolve('')
                reader.readAsDataURL(file)
            })
            if (data && safeUrl(data, { image: true })) this.pending.push({ data, name: file.name, mime: file.type })
        }
        this.renderPending()
    }

    scheduleRender() {
        if (this.frame) return
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16)
        this.frame = raf(() => {
            this.frame = 0
            const stick = this.nearBottom()
            this.renderThread()
            if (stick) this.scrollToEnd()
        })
    }

    nearBottom() {
        const el = this.scroller
        return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }

    scrollToEnd(instant) {
        const el = this.scroller
        if (!el) return
        if (instant) el.scrollTop = el.scrollHeight
        else el.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' })
    }

    // ------------------------------------------------------------ actions

    async copy(text, button) {
        let ok = false
        try {
            await navigator.clipboard.writeText(text)
            ok = true
        } catch {
            const area = h('textarea', { style: 'position:fixed;opacity:0' })
            area.value = text
            this.root.append(area)
            area.select()
            try {
                ok = document.execCommand('copy')
            } catch {
                ok = false
            }
            area.remove()
        }
        if (button) {
            button.innerHTML = ok ? icons.check : icons.copy
            setTimeout(() => {
                button.innerHTML = icons.copy
            }, 1500)
        }
        this.announce(ok ? 'Copied' : 'Could not copy')
    }

    async rate(msg, value) {
        if (!msg.messageId || msg.feedback === value) return
        const previous = msg.feedback
        msg.feedback = value
        msg.rev++
        this.scheduleRender()
        try {
            await this.api.feedback({ messageId: msg.messageId, chatId: this.chatId, rating: value === 'up' ? 'THUMBS_UP' : 'THUMBS_DOWN' })
            this.announce('Thanks for the feedback')
            this.save()
        } catch {
            msg.feedback = previous
            msg.rev++
            this.scheduleRender()
            this.announce('Could not send feedback')
        }
    }

    chooseAction(msg, element) {
        const data = msg.action?.data || {}
        msg.action = null
        msg.rev++
        if (String(element.type || '').includes('agentflowv2')) {
            const type = String(element.type).includes('approve') ? 'proceed' : 'reject'
            this.send(element.label, { humanInput: { type, startNodeId: data.nodeId, feedback: '' } })
        } else {
            this.send(element.label, { action: msg.actionRaw })
        }
    }

    retry(msg) {
        const index = this.messages.indexOf(msg)
        const question = msg.retry
        if (index > 0 && this.messages[index - 1]?.role === 'user') this.messages.splice(index - 1, 2)
        else this.messages.splice(index, 1)
        this.nodes.clear()
        this.send(question.text, question.extra, question.uploads)
    }

    abort(byUser) {
        if (this.controller) {
            this.controller.abort()
            this.controller = null
        }
        if (byUser) this.announce('Stopped')
    }

    async send(text, extra = {}, uploadsOverride) {
        if (this.state !== 'ready' || this.busy) return
        const question = typeof text === 'string' ? text : this.input?.value || ''
        const uploads = uploadsOverride || this.pending.map((item) => ({ data: item.data, type: 'file', name: item.name, mime: item.mime }))
        if (!question.trim() && !uploads.length) return
        if (this.input && typeof text !== 'string') {
            this.input.value = ''
            this.autosize()
        }
        this.pending = []
        this.renderPending()

        const user = {
            id: nextId('m'),
            role: 'user',
            text: question.trim(),
            images: uploads.map((item) => item.data),
            status: 'done',
            rev: 0
        }
        const bot = { id: nextId('m'), role: 'bot', text: '', status: 'streaming', sources: [], artifacts: [], rev: 0 }
        this.messages.push(user, bot)
        this.setBusy(true)
        this.renderShellHeaderOnly()
        this.renderThread()
        this.scrollToEnd()
        this.announce('Answering')

        const body = { question: question.trim() }
        if (this.chatId) body.chatId = this.chatId
        if (this.sessionToken) body.sessionToken = this.sessionToken
        if (uploads.length) body.uploads = uploads
        if (extra.humanInput) body.humanInput = extra.humanInput
        if (extra.action) body.action = extra.action
        if (this.options.overrideConfig && typeof this.options.overrideConfig === 'object')
            body.overrideConfig = this.options.overrideConfig

        const controller = new AbortController()
        this.controller = controller
        const touch = () => {
            bot.rev++
            this.scheduleRender()
        }
        try {
            await this.api.send(
                body,
                {
                    onEvent: (evt) => this.onEvent(bot, evt, touch),
                    onJson: (json) => this.onJson(bot, json)
                },
                controller.signal
            )
            if (!bot.text && !bot.error && !bot.artifacts.length && !bot.action) bot.text = bot.fallbackText || ''
            if (!bot.text && !bot.error && !bot.artifacts.length && !bot.action) bot.error = 'The answer was empty. Try asking another way.'
        } catch (error) {
            if (controller.signal.aborted) {
                if (!bot.text) bot.text = '_Stopped._'
            } else {
                const info = describeError(error, this.config.errorMessage)
                if (info.kind === 'private' || info.kind === 'origin') {
                    this.setBusy(false)
                    this.block(info)
                    return
                }
                bot.error = info.message
                bot.retry = { text: question.trim(), extra, uploads }
            }
        } finally {
            if (this.controller === controller) this.controller = null
        }
        bot.status = 'done'
        if (bot.run && bot.run.phase !== 'done' && bot.run.phase !== 'failed')
            bot.run = reduceRun(bot.run, bot.error ? 'error' : 'final', {})
        bot.rev++
        this.setBusy(false)
        this.renderShellHeaderOnly()
        this.renderThread()
        this.scrollToEnd()
        this.announce(bot.error ? bot.error : `Answer: ${bot.text.replace(/[#*_`>|]/g, '').slice(0, 280)}`)
        this.save()
        this.focusInput()
    }

    setBusy(value) {
        this.busy = value
        this.updateSendButton()
        this.updateStatus()
    }

    renderShellHeaderOnly() {
        const header = this.window.querySelector('.dc-header')
        if (header) header.replaceWith(this.renderHeader())
    }

    onEvent(bot, evt, touch) {
        const { event, data } = evt
        if (event === 'token' && typeof data === 'string') {
            bot.text += data
            return touch()
        }
        if (event === 'start') return touch()
        if (event === 'sourceDocuments') {
            bot.sources = normalizeSources(data)
            return touch()
        }
        if (event === 'artifacts') {
            bot.artifacts = normalizeArtifacts(data)
            return touch()
        }
        if (event === 'action') {
            bot.action = data && typeof data === 'object' ? data : null
            bot.actionRaw = data
            return touch()
        }
        if (event === 'agentFlowExecutedData') {
            bot.fallbackText = lastAgentflowText(data) || bot.fallbackText
            return
        }
        if (event === 'metadata' && data && typeof data === 'object') {
            if (typeof data.chatId === 'string') this.chatId = data.chatId
            if (typeof data.sessionToken === 'string') this.sessionToken = data.sessionToken
            if (typeof data.chatMessageId === 'string') bot.messageId = data.chatMessageId
            if (data.followUpPrompts) bot.followUps = parseFollowUps(data.followUpPrompts)
            if (data.action && !bot.action) {
                bot.action = data.action
                bot.actionRaw = data.action
            }
            return touch()
        }
        if (event === 'error') {
            const status = typeof evt.status === 'number' ? evt.status : 0
            const info = status ? describeError({ status }, this.config.errorMessage) : null
            bot.error =
                info && info.kind !== 'error'
                    ? info.message
                    : this.config.errorMessage ||
                      (typeof data === 'string' && data ? data.slice(0, 300) : 'Something went wrong. Try again.')
            if (bot.run) bot.run = reduceRun(bot.run, 'error', { message: bot.error })
            return touch()
        }
        if (typeof event === 'string' && event.startsWith('harness.')) {
            const type = event.slice(8)
            if (type === 'recorded') return
            const payload = data && typeof data === 'object' ? data : {}
            bot.run = reduceRun(bot.run || emptyRun(payload.harness), type, payload)
            if (type === 'partial' && payload.phase === 'answer' && !payload.streamedAsToken && typeof payload.text === 'string')
                bot.text += payload.text
            if (type === 'final' && !bot.text && typeof payload.text === 'string') bot.fallbackText = payload.text
            return touch()
        }
    }

    onJson(bot, json) {
        if (!json || typeof json !== 'object') return
        if (typeof json.chatId === 'string') this.chatId = json.chatId
        if (typeof json.sessionToken === 'string') this.sessionToken = json.sessionToken
        if (typeof json.chatMessageId === 'string') bot.messageId = json.chatMessageId
        if (typeof json.text === 'string') bot.text = json.text
        else if (json.json !== undefined) bot.text = '```json\n' + JSON.stringify(json.json, null, 2) + '\n```'
        if (!bot.text) bot.fallbackText = lastAgentflowText(json.agentFlowExecutedData)
        bot.sources = normalizeSources(json.sourceDocuments)
        bot.artifacts = normalizeArtifacts(json.artifacts)
        if (json.followUpPrompts) bot.followUps = parseFollowUps(json.followUpPrompts)
        if (json.action) {
            bot.action = typeof json.action === 'string' ? safeJson(json.action) : json.action
            bot.actionRaw = bot.action
        }
        if (json.harness || Array.isArray(json.agents)) {
            bot.run = reduceRun(emptyRun(json.harness || ''), 'final', {
                harness: json.harness,
                trace: Array.isArray(json.agents) ? { specialists: json.agents } : undefined,
                timings: json.timings
            })
        }
    }

    destroy() {
        this.abort()
        this.media?.removeEventListener?.('change', this.onMedia)
        this.root.innerHTML = ''
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}
