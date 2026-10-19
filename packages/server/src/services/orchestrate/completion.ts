const STRIP_KEYS = new Set([
    'chatId',
    'chatMessageId',
    'sessionId',
    'sessionToken',
    'memoryType',
    'question',
    'followUpPrompts',
    'flowVariables',
    'action',
    'executionId'
])

export function answerText(result: unknown): string {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return result == null ? '' : JSON.stringify(result)
    }
    const row = result as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.json !== undefined) return JSON.stringify(row.json)
    const rest: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
        if (!STRIP_KEYS.has(key)) rest[key] = value
    }
    return JSON.stringify(rest)
}
