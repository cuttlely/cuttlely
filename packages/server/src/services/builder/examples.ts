const words = (text: string) =>
    new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length > 3)
    )

// The items most like the request, by shared words; ties keep their order.
export function closest<T>(request: string, items: T[], textOf: (item: T) => string, max: number): T[] {
    const wanted = words(request)
    return items
        .map((item, index) => ({ item, index, score: [...words(textOf(item))].filter((word) => wanted.has(word)).length }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, max)
        .map(({ item }) => item)
}
