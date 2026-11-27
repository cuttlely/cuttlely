// A final can precede the last buffered answer delta. Replace its fallback when the first
// actual delta arrives. A marked delta is delivered separately by the token handler.
export function harnessStreamAnswer(current, event) {
    if (event?.type === 'partial' && event.phase === 'answer' && typeof event.text === 'string' && event.text) {
        const prior = current.fallback ? '' : current.text
        return { text: event.streamedAsToken ? prior : prior + event.text, fallback: false }
    }
    if (event?.type === 'final' && typeof event.text === 'string' && !current.text) return { text: event.text, fallback: true }
    return current
}
