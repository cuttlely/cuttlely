// Money masking for the docs screenshots. maskTexts works on a page's text node values in document order,
// so an Estimated cost label in one element and its amount in the next are handled together.

const LABEL = /estimated\s+cost/i
const LABEL_SENTENCE = /\s*Estimated\s+cost\b.*?(?:\.(?=\s|$)|$)/gi
const LEAD_IN = /^[\s:≈~]*(?:about|approx\.?|approximately)?[\s:≈~]*$/i
const AMOUNT = /^[\s:≈~]*(?:(?:about|approx\.?|approximately)\s*)?(?:US)?\$\s?\d[\d.,]*/i
export function moneyHit(text) {
    return text.match(/\$\s?\d/) || text.match(/(?<![A-Za-z0-9.-])\d+\.\d{2}\b/)
}

export function costHit(text) {
    return text.match(LABEL)
}

export function maskTexts(values, { keepAmounts = false } = {}) {
    const out = []
    const leftovers = []
    let labelOpen = false
    for (const original of values) {
        let value = original || ''
        if (labelOpen && value.trim()) {
            if (LEAD_IN.test(value)) {
                out.push('')
                continue
            }
            value = value.replace(AMOUNT, '')
            labelOpen = false
            const rest = value.split(/\.(?=\s|$)/)[0]
            if (/\$\s?\d/.test(rest)) leftovers.push(rest.trim().slice(0, 40))
        }
        if (LABEL.test(value)) {
            labelOpen = /estimated\s+cost(?![\s\S]*\d)/i.test(value)
            value = value.replace(LABEL_SENTENCE, '')
        }
        if (/\$\s?\d/.test(value)) {
            if (!keepAmounts) value = value.replace(/,?\s*estimated:?\s*\$?[\d.,]*/gi, '').replace(/\$[\d.,]+/g, '')
            value = value.replace(/(\d(?:\.\d)?\s*s)\.\d{3,}/g, '$1')
        }
        out.push(value)
    }
    return { values: out, leftovers }
}
