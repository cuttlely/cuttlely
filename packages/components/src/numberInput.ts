export const parseOptionalNumber = (value: unknown): number | undefined => {
    const parsed = parseFloat(String(value))
    return Number.isFinite(parsed) ? parsed : undefined
}
