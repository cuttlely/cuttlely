// Reads the prediction endpoint's event stream. Each frame is a blank-line separated block whose
// "data:" lines carry one JSON object: { event, data, ...extra }. Other field lines are ignored.

export function createEventParser(onEvent) {
    let buffer = ''
    const emitBlock = (block) => {
        const data = []
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
        }
        if (!data.length) return
        const text = data.join('\n')
        let payload
        try {
            payload = JSON.parse(text)
        } catch {
            return
        }
        if (payload && typeof payload === 'object' && typeof payload.event === 'string') onEvent(payload)
    }
    return {
        push(chunk) {
            buffer += chunk
            let match
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, match.index)
                buffer = buffer.slice(match.index + match[0].length)
                emitBlock(block)
            }
        },
        end() {
            if (buffer.trim()) emitBlock(buffer)
            buffer = ''
        }
    }
}
