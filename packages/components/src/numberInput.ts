export const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string') return undefined

    const trimmed = value.trim()
    if (!trimmed) return undefined

    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
}
