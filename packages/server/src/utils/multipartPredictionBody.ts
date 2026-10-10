const JSON_FIELDS = ['uploads', 'history', 'overrideConfig', 'form', 'action', 'humanInput'] as const

/**
 * Multipart text fields arrive as strings. JSON prediction bodies already have objects.
 * Only a string that looks like JSON is parsed, so a plain question is left alone.
 */
export const coerceMultipartPredictionBody = (body: Record<string, unknown> | undefined): void => {
    if (!body || typeof body !== 'object') return
    for (const key of JSON_FIELDS) {
        const value = body[key]
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
        try {
            body[key] = JSON.parse(trimmed)
        } catch {
            delete body[key]
        }
    }
}
