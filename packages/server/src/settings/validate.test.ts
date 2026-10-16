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

    it('checks invite and mail values the page can save', () => {
        expect(checkValue(def('INVITE_TOKEN_EXPIRY_IN_HOURS'), '24')).toEqual({ ok: true, value: '24' })
        expect(checkValue(def('INVITE_TOKEN_EXPIRY_IN_HOURS'), '200')).toMatchObject({ ok: false, code: 'OUT_OF_RANGE', min: 1, max: 168 })
        expect(checkValue(def('PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS'), '1')).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
        expect(checkValue(def('SMTP_PORT'), '587')).toEqual({ ok: true, value: '587' })
        expect(checkValue(def('SMTP_PORT'), '70000')).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
        expect(checkValue(def('SENDER_EMAIL'), 'baker@example.com')).toEqual({ ok: true, value: 'baker@example.com' })
        expect(checkValue(def('SENDER_EMAIL'), 'not-an-email').ok).toBe(false)
        expect(checkValue(def('INVITE_DELIVERY'), 'link')).toEqual({ ok: true, value: 'link' })
        expect(checkValue(def('INVITE_DELIVERY'), 'sms').ok).toBe(false)
        expect(def('SMTP_PASSWORD').envOnly).toBe(true)
        expect(def('INVITE_TOKEN_EXPIRY_IN_HOURS').panelFirst).toBe(true)
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

    it('checks log field names and LangSmith project and endpoint without repeating the text', () => {
        const pasted = 'https://user:fake-token-b3@example.invalid/hook?token=fake-token-b3'
        const fields = checkValue(def('LOG_SANITIZE_BODY_FIELDS'), ' Password, token, password ')
        expect(fields).toEqual({ ok: true, value: 'password,token' })
        const badFields = checkValue(def('LOG_SANITIZE_HEADER_FIELDS'), pasted)
        expect(badFields.ok).toBe(false)
        if (!badFields.ok) {
            expect(badFields.code).toBe('INVALID_NAME')
            expect(badFields.error).not.toContain('fake-token-b3')
        }
        expect(checkValue(def('LANGSMITH_PROJECT'), 'customer care')).toEqual({ ok: true, value: 'customer care' })
        const badProject = checkValue(def('LANGSMITH_PROJECT'), pasted)
        expect(badProject.ok).toBe(false)
        if (!badProject.ok) {
            expect(badProject.code).toBe('INVALID_NAME')
            expect(badProject.error).not.toContain('fake-token-b3')
        }
        expect(checkValue(def('LANGSMITH_ENDPOINT'), 'https://langsmith.example.com/api')).toEqual({
            ok: true,
            value: 'https://langsmith.example.com/api'
        })
        const badEndpoint = checkValue(def('LANGSMITH_ENDPOINT'), pasted)
        expect(badEndpoint.ok).toBe(false)
        if (!badEndpoint.ok) {
            expect(badEndpoint.code).toBe('INVALID_URL')
            expect(badEndpoint.error).not.toContain('fake-token-b3')
            expect(badEndpoint.error).not.toContain('example.invalid')
        }
        expect(checkValue(def('LANGSMITH_ENDPOINT'), '').ok).toBe(true)
    })

    it('takes a positive trace content limit or 0 for no limit, and refuses anything else', () => {
        const limit = def('CUTTLELY_OTEL_TRACES_CONTENT_MAX')
        expect(limit.defaultValue).toBe('4000')
        expect(limit.options?.find((option) => option.value === '0')?.label).toBe('No limit')
        expect(limit.options?.some((option) => option.value === limit.defaultValue)).toBe(false)
        expect(checkValue(limit, '4000')).toEqual({ ok: true, value: '4000' })
        expect(checkValue(limit, '0')).toEqual({ ok: true, value: '0' })
        expect(checkValue(limit, ' 20000 ')).toEqual({ ok: true, value: '20000' })
        expect(checkValue(limit, 250000)).toEqual({ ok: true, value: '250000' })
        expect(checkValue(limit, '007')).toEqual({ ok: true, value: '7' })
        expect(checkValue(limit, '')).toEqual({ ok: true, value: '' })
        for (const bad of ['-1', '1.5', '1e6', 'unlimited', 'lots', '12abc', '99999999999999999999', -5, 2.5]) {
            const checked = checkValue(limit, bad)
            expect(checked).toMatchObject({ ok: false, code: 'INVALID' })
            if (!checked.ok) expect(checked.error).toContain('choose No limit')
        }
    })

    it('treats blank and null as remove', () => {
        expect(checkValue(def('LOG_LEVEL'), '  ')).toEqual({ ok: true, value: '' })
        expect(checkValue(def('LOG_LEVEL'), null)).toEqual({ ok: true, value: '' })
    })
})
