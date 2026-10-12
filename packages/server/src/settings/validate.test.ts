import { settingFor } from './registry'
import { checkValue } from './validate'

const def = (key: string) => {
    const setting = settingFor(key)
    if (!setting) throw new Error(`missing ${key}`)
    return setting
}

describe('checking values from the page', () => {
    it('accepts only the on and off values of a switch, and maps booleans', () => {
        expect(checkValue(def('CUTTLELY_VERSIONS'), 'off')).toEqual({ ok: true, value: 'off' })
        expect(checkValue(def('CUTTLELY_VERSIONS'), false)).toEqual({ ok: true, value: 'off' })
        expect(checkValue(def('CUTTLELY_MODELS_DEV'), true)).toEqual({ ok: true, value: '1' })
        expect(checkValue(def('CUTTLELY_VERSIONS'), 'maybe').ok).toBe(false)
    })

    it('keeps selects to their options unless a typed value is allowed', () => {
        expect(checkValue(def('DATABASE_TYPE'), 'postgres').ok).toBe(true)
        expect(checkValue(def('DATABASE_TYPE'), 'mysql').ok).toBe(false)
        expect(checkValue(def('MODEL_LIST_CONFIG_JSON'), '/srv/models.json')).toEqual({ ok: true, value: '/srv/models.json' })
    })

    it('checks numbers against the range the page shows', () => {
        expect(checkValue(def('DATABASE_PORT'), '5432').ok).toBe(true)
        expect(checkValue(def('DATABASE_PORT'), 70000).ok).toBe(false)
        expect(checkValue(def('DATABASE_PORT'), '54x').ok).toBe(false)
        const timeout = def('CUTTLELY_HARNESS_TURN_BUDGET_MS')
        expect(timeout.unit).toBe('ms-as-seconds')
        expect(checkValue(timeout, String((timeout.max ?? 0) * 1000)).ok).toBe(true)
        expect(checkValue(timeout, String(((timeout.max ?? 0) + 1) * 1000)).ok).toBe(false)
        const rowCap = def('CUTTLELY_ANALYST_ROW_CAP')
        expect(rowCap.defaultValue).toBe('100')
        expect(checkValue(rowCap, '').ok).toBe(true)
        expect(checkValue(rowCap, '100')).toEqual({ ok: true, value: '100' })
        expect(checkValue(rowCap, '1').ok).toBe(true)
        expect(checkValue(rowCap, '1000').ok).toBe(true)
        expect(checkValue(rowCap, '1001').ok).toBe(false)
        expect(checkValue(rowCap, '0').ok).toBe(false)
        const queryTimeout = def('CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS')
        expect(queryTimeout.defaultValue).toBe('15000')
        expect(queryTimeout.unit).toBe('ms-as-seconds')
        expect(checkValue(queryTimeout, '15000')).toEqual({ ok: true, value: '15000' })
        expect(checkValue(queryTimeout, '120000').ok).toBe(true)
        expect(checkValue(queryTimeout, '121000').ok).toBe(false)
        expect(checkValue(queryTimeout, '500').ok).toBe(false)
    })

    it('tidies lists and refuses multi-line text', () => {
        expect(checkValue(def('CORS_ORIGINS'), 'https://a.example.com\n https://a.example.com, https://b.example.com')).toEqual({
            ok: true,
            value: 'https://a.example.com,https://b.example.com'
        })
        expect(checkValue(def('WORKOS_REDIRECT_URI'), 'https://a.example.com\nx').ok).toBe(false)
        expect(checkValue(def('WORKOS_API_KEY'), 'a\u0000b').ok).toBe(false)
    })

    it('treats blank and null as remove', () => {
        expect(checkValue(def('LOG_LEVEL'), '  ')).toEqual({ ok: true, value: '' })
        expect(checkValue(def('LOG_LEVEL'), null)).toEqual({ ok: true, value: '' })
    })
})
