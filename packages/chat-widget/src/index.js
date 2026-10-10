// Public entry. `mount` renders a chat into any element; `<cuttlely-chat>` does the same from HTML.

import { ChatWidget } from './widget.js'

export { ChatWidget }
export { renderMarkdown, escapeHtml, safeUrl } from './markdown.js'
export { normalizeConfig } from './config.js'

export const ELEMENT_NAME = 'cuttlely-chat'

/**
 * Renders a chat into `target` (it gets a shadow root).
 * options: flowId (required), apiHost, mode ('bubble' | 'page'), theme ('auto' | 'light' | 'dark'), open,
 * config (share-setting overrides), overrideConfig, blocked ('private' | 'missing' | 'origin'), storage
 */
export function mount(target, options = {}) {
    if (!target) throw new Error('Cuttlely chat: mount needs a target element')
    if (!options.flowId) throw new Error('Cuttlely chat: flowId is required')
    target.__cuttlelyChat?.destroy()
    const widget = new ChatWidget(target, options)
    target.__cuttlelyChat = widget
    return widget
}

function attr(el, name) {
    const value = el.getAttribute(name)
    return value === null || value === '' ? undefined : value
}

/** Defines <cuttlely-chat flow-id="..." mode="page|bubble" theme="auto|light|dark" api-host="...">. */
export function defineElement(defaultHost) {
    if (typeof customElements === 'undefined' || customElements.get(ELEMENT_NAME)) return
    class CuttlelyChatElement extends HTMLElement {
        static get observedAttributes() {
            return ['flow-id', 'api-host', 'mode', 'theme']
        }
        connectedCallback() {
            this.render()
        }
        attributeChangedCallback(name, oldValue, newValue) {
            if (!this.isConnected || oldValue === newValue) return
            if (name === 'theme' && this.widget) this.widget.setTheme(newValue || 'auto')
            else this.render()
        }
        disconnectedCallback() {
            this.widget?.destroy()
            this.widget = null
        }
        render() {
            const flowId = attr(this, 'flow-id')
            if (!flowId) return
            this.widget = mount(this, {
                flowId,
                apiHost: attr(this, 'api-host') || defaultHost,
                mode: attr(this, 'mode') === 'page' ? 'page' : 'bubble',
                theme: attr(this, 'theme') || 'auto',
                open: this.hasAttribute('open')
            })
        }
        open() {
            this.widget?.open()
        }
        close() {
            this.widget?.close()
        }
        reset() {
            this.widget?.reset()
        }
    }
    customElements.define(ELEMENT_NAME, CuttlelyChatElement)
}
