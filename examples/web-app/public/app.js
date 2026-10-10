// Sends the question to this app's own server (/api/ask), which adds the Cuttlely API key.
// Reads the server-sent events as they arrive and shows the answer token by token.
const log = document.getElementById('log')
const input = document.getElementById('question')
const button = document.getElementById('ask')
// This app's own conversation id. The Cuttlely chat id and session token stay on the server.
let conversationId = sessionStorage.getItem('conversationId') || ''

function add(className, text) {
    const el = document.createElement('p')
    el.className = className
    el.textContent = text
    log.appendChild(el)
    return el
}

async function ask() {
    const question = input.value.trim()
    if (!question) return
    input.value = ''
    button.disabled = true
    add('q', question)
    const answer = add('a', '')
    try {
        const res = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, conversationId })
        })
        if (!res.ok) {
            const { error } = await res.json()
            throw new Error(error)
        }
        conversationId = res.headers.get('X-Conversation-Id') || conversationId
        sessionStorage.setItem('conversationId', conversationId)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split('\n\n')
            buffer = events.pop()
            for (const block of events) {
                const line = block.split('\n').find((l) => l.startsWith('data:'))
                if (!line) continue
                const { event, data } = JSON.parse(line.slice(5))
                if (event === 'token') answer.textContent += data
                if (event === 'error') throw new Error(typeof data === 'string' ? data : 'The assistant hit an error.')
            }
        }
    } catch (err) {
        answer.className = 'a error'
        answer.textContent = err.message
    } finally {
        button.disabled = false
        input.focus()
    }
}

button.addEventListener('click', ask)
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask()
})
