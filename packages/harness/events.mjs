// Wire names are `harness.` plus one of these. `partial.text` is a delta, sent as the model or tool produces it.
export const HARNESS_EVENT_TYPES = ['route', 'specialist', 'tool', 'partial', 'handoff', 'final']

export function emitHarnessEvent(onEvent, event) {
    if (typeof onEvent !== 'function') return
    try {
        onEvent(event)
    } catch {
        // A listener must not fail the turn, and its error must not print the payload.
    }
}
