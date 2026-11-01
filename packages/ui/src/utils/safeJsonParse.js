/**
 * Parse a saved JSON string without throwing.
 *
 * Returns `fallback` for a value that is not a string, is empty or only whitespace, or is not valid JSON
 * (for example a truncated value such as `{"a":`). A valid JSON string parses exactly as `JSON.parse` does.
 * Use it where a component parses a stored value while it renders, so one bad value cannot crash the page.
 */
export const safeJsonParse = (value, fallback = {}) => {
    if (typeof value !== 'string' || !value.trim()) return fallback
    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

export default safeJsonParse
