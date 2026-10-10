// Unknown node names used to become HTTP 500 because the icon lookup threw and the catch
// rewrote every error as 500. A non-file icon, or no node at all, is a placeholder instead.
export const nodeIconPath = (icon: unknown): string | undefined => {
    if (typeof icon !== 'string') return undefined
    if (icon.endsWith('.svg') || icon.endsWith('.png') || icon.endsWith('.jpg')) return icon
    return undefined
}
