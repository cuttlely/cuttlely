// Chat text for one harness event. A prediction stream sends each answer delta twice: as
// `harness.partial` (marked `streamedAsToken`) and as `token`. The `token` handler appends it,
// so a marked partial adds nothing here. The harness canvas chat gets only harness events, unmarked.
export function harnessMessageText(message, event) {
    const current = typeof message === 'string' ? message : ''
    if (event?.type === 'partial' && event.phase === 'answer' && typeof event.text === 'string') {
        return event.streamedAsToken ? current : current + event.text
    }
    if (event?.type === 'final' && typeof event.text === 'string' && !current) return event.text
    return current
}
