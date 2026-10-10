// Focus and selection do not count. A drag that stays put does not count.

export function sameCanvasValue(previous, next) {
    if (Object.is(previous, next)) return true
    if ((previous == null || previous === '') && (next == null || next === '')) return true
    if (previous != null && next != null && typeof previous !== 'object' && typeof next !== 'object') {
        return String(previous) === String(next)
    }
    return false
}

export function nodeMoved(start, position) {
    if (!start || !position) return false
    return start.x !== position.x || start.y !== position.y
}
