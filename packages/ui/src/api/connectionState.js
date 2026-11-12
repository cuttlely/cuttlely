let count = 0
const listeners = new Set()

const notify = () => {
    for (const listener of [...listeners]) listener(count)
}

export const beginReconnect = () => {
    count += 1
    notify()
}

export const endReconnect = () => {
    count = Math.max(0, count - 1)
    notify()
}

export const getReconnectCount = () => count

export const subscribeReconnect = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export const resetReconnectState = () => {
    count = 0
    notify()
}
