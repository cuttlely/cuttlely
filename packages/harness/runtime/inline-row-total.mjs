// Only a complete, closed request can establish the origin of the inputs. The
// specialist's task, its files, its history and its prose are never substituted.
export function inlineRowTotal(question) {
    if (typeof question !== 'string' || question.length > 8192) return
    const text = question
        .trim()
        .replace(/[.!?]$/, '')
        .trim()
        .replace(/^(?:please\s+)?(?:using (?:the )?(?:saved )?python(?: tool)?,\s*)?/i, '')
    let field, values
    const source =
        /^collect (?:the )?([a-z][a-z0-9_]{0,31}) from (?:[a-z]+ )?rows with values ([-\d,\s]+) and (?:print|return|report|calculate) (?:their |the )?(?:sum|total) and (?:the )?row count$/i.exec(
            text
        )
    if (source) {
        // A name for the rows may describe their subject, but never an owner or a stored source.
        const kind = / from (?:([a-z]+) )?rows /i.exec(text)?.[1]?.toLowerCase()
        if (kind && !['input', 'supplied', 'provided', 'given', 'shipment', 'inventory', 'invoice', 'order', 'sample'].includes(kind))
            return
        field = source[1]
        const literal = source[2].trim()
        if (!/^-?(?:0|[1-9]\d*)(?:\s*,\s*-?(?:0|[1-9]\d*)){0,127}$/.test(literal)) return
        values = literal.split(',').map(Number)
    } else {
        const trailing = /^(.*?)\s+(?:in|for) (?:these|this|the following) (?:inline |supplied )?(?:rows|table)\s*:\s*(\[[\s\S]*\])$/i.exec(
            text
        )
        const leading =
            !trailing &&
            /^(?:here (?:are|is) (?:the|my|our)|(?:using|given) (?:these|this|the following)) (?:inline |supplied )?(?:rows|table)\s*:\s*(\[[\s\S]*\])\s*[.,;]\s*(.+)$/i.exec(
                text
            )
        if (!trailing && !leading) return
        const request = trailing ? trailing[1] : leading[2]
        // Separate the calculation from its already-delimited input. Both complete
        // clauses must describe the table, in either order, with no extra request.
        const clauses = request.replace(/^(?:please |calculate |compute )/i, '').split(/,?\s+and\s+/i)
        if (clauses.length !== 2) return
        const count =
            /^(?:count (?:the )?rows|(?:report )?(?:the )?(?:row count|number of rows)|how many rows (?:are there|are in (?:it|the table)))$/i
        const sum = /^(?:(?:sum|total) (?:the )?|(?:what is |report )?(?:the )?(?:sum|total) (?:of|for) )([a-z][a-z0-9_]{0,31})$/i
        const summation = count.test(clauses[0]) ? sum.exec(clauses[1]) : count.test(clauses[1]) ? sum.exec(clauses[0]) : undefined
        if (!summation) return
        field = summation[1]
        let items
        try {
            items = JSON.parse(trailing ? trailing[2] : leading[1])
        } catch {
            return
        }
        if (!Array.isArray(items) || items.length < 1 || items.length > 128) return
        if (
            !items.every(
                (row) =>
                    row &&
                    typeof row === 'object' &&
                    !Array.isArray(row) &&
                    Object.hasOwn(row, field) &&
                    Number.isSafeInteger(row[field]) &&
                    Object.keys(row).length <= 64 &&
                    Object.entries(row).every(
                        ([key, value]) =>
                            /^[a-z][a-z0-9_ -]{0,63}$/i.test(key) &&
                            (value === null || ['string', 'number', 'boolean'].includes(typeof value))
                    )
            )
        )
            return
        values = items.map((row) => row[field])
    }
    if (
        !values.every(Number.isSafeInteger) ||
        /^(?:sql|database|query|table|schema|password|credential|token|__proto__|constructor|prototype)$/i.test(field)
    )
        return
    const total = values.reduce((sum, value) => sum + BigInt(value), 0n)
    return {
        field,
        values,
        output: total + ' ' + values.length + '\n',
        summary: total + ' ' + field + ' from ' + values.length + (values.length === 1 ? ' row.' : ' rows.')
    }
}
