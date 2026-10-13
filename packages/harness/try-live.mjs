// Try ids that have a run in this process. A restart begins empty, so every try directory is a leftover.
const live = new Set()

export function noteLiveTry(name) {
    if (name) live.add(name)
}

export function endLiveTry(name) {
    if (name) live.delete(name)
}

export function isLiveTry(name) {
    return live.has(name)
}
