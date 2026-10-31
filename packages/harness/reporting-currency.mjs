import { HarnessError } from './errors.mjs'

export const currencySymbolCodes = {
    $: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'ARS', 'CLP', 'COP', 'BRL'],
    '€': ['EUR'],
    '£': ['GBP'],
    '¥': ['JPY', 'CNY'],
    '₹': ['INR'],
    '₩': ['KRW'],
    '₽': ['RUB'],
    '₺': ['TRY'],
    '₪': ['ILS'],
    '₫': ['VND'],
    '฿': ['THB'],
    '₦': ['NGN'],
    '₱': ['PHP'],
    '₴': ['UAH']
}

export function normalizeReportingCurrencySymbol(value) {
    if (value == null || value === '') return undefined
    if (typeof value !== 'string' || !Object.hasOwn(currencySymbolCodes, value))
        throw new HarnessError('trusted_output', 'Reporting currency must be one supported currency symbol.')
    return value
}

// Only the author-controlled output contracts establish this convention. Source
// data, comments, model prose and interpretation paths cannot opt into it.
export function reportingCurrencySymbol(contracts = []) {
    const declared = new Set(contracts.map((entry) => normalizeReportingCurrencySymbol(entry.reportingCurrencySymbol)).filter(Boolean))
    return declared.size === 1 ? [...declared][0] : undefined
}

export function monetaryField(path) {
    const name = path.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_')
    if (
        /(?:^|_)(?:pct|percent|percentage|rate|probability|likelihood|chance|score|composite|ratio|count|rank|year|month|day|id|ids|rows|accounts|customers|opportunities|events|records)(?:_|$)/i.test(
            name
        )
    )
        return false
    return /(?:^|_)(?:acv|nacv|racv|arr|tcv|ram|amount|revenue|bookings|sales|deposit|dollars|realized_churn|confirmed_churn|realized_loss|confirmed_loss)(?:_|$)/i.test(
        name
    )
}

function decimal(value) {
    const text = String(value).replaceAll(',', '').replace(/^\+/, '')
    if (text.length > 256) return null
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
    if (!match) return null
    const fraction = match[3] || ''
    if (fraction.length > 64) return null
    return { negative: match[1] === '-', units: BigInt(match[2] + fraction), scale: fraction.length }
}

// Compact display is formatting, not a new calculation. Round a single actual
// monetary source value to the displayed precision, half away from zero. BigInt
// avoids changing financial decimal boundaries or large integer values.
export function compactMoneyMatches(source, coefficient, suffix) {
    const actual = decimal(source),
        claim = decimal(coefficient),
        exponent = { K: 3, M: 6, B: 9 }[suffix]
    if (!actual || !claim || exponent == null || claim.scale > 3 || actual.negative !== claim.negative) return false
    const numerator = actual.units * 10n ** BigInt(claim.scale),
        denominator = 10n ** BigInt(actual.scale + exponent),
        rounded = (numerator * 2n + denominator) / (denominator * 2n)
    // Do not turn a nonzero source value into a displayed zero.
    return !(actual.units !== 0n && rounded === 0n) && rounded === claim.units
}

export function reportingCurrencyCaption(symbol) {
    return symbol ? `Monetary amounts use the reporting symbol ${symbol}.` : ''
}
