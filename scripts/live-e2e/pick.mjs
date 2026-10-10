// Picks the cases a live check runs from a comma list (E2E_ONLY, GALLERY_ONLY). Matching ignores case and extra spaces.
// A name that matches nothing is an error, so a typo never turns into a run that checks nothing and passes.
export function pickCases(items, list, nameOf = (item) => item.canvas) {
    const wanted = String(list || '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    if (!wanted.length) return items
    const known = items.map((item) => String(nameOf(item)).toLowerCase())
    const unknown = wanted.filter((name) => !known.includes(name))
    if (unknown.length) throw new Error(`No case named ${unknown.map((name) => `"${name}"`).join(', ')}. Known: ${known.join(', ')}`)
    return items.filter((_item, index) => wanted.includes(known[index]))
}
