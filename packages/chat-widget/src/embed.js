// The script the Cuttlely server serves at /embed/chat.js.
//   <script src="https://your-cuttlely/embed/chat.js" data-flow-id="FLOW_ID" defer></script>  adds the chat bubble.
//   <cuttlely-chat flow-id="FLOW_ID" mode="page"></cuttlely-chat>  renders a full-page chat where the tag is.
// The server address defaults to wherever this script was loaded from.

import { defineElement, mount } from './index.js'

const script = typeof document !== 'undefined' ? document.currentScript : null
const scriptHost = (() => {
    try {
        return script && script.src ? new URL(script.src).origin : location.origin
    } catch {
        return location.origin
    }
})()

defineElement(scriptHost)

function mountFromScript() {
    const data = script?.dataset || {}
    const flowId = data.flowId || data.flowid
    if (!flowId) return
    const mode = data.mode === 'page' ? 'page' : 'bubble'
    let target
    if (mode === 'page' && data.target) target = document.querySelector(data.target)
    if (!target) {
        target = document.createElement('cuttlely-chat-root')
        target.style.display = mode === 'page' ? 'block' : 'contents'
        if (mode === 'page') target.style.height = '100%'
        document.body.append(target)
    }
    mount(target, { flowId, apiHost: data.apiHost || scriptHost, mode, theme: data.theme || 'auto', open: data.open === 'true' })
}

const api = {
    mount: (target, options) => mount(target, { apiHost: scriptHost, ...options }),
    version: typeof __WIDGET_VERSION__ === 'string' ? __WIDGET_VERSION__ : 'dev'
}
if (typeof window !== 'undefined') window.cuttlelyChat = api

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFromScript, { once: true })
    else mountFromScript()
}
