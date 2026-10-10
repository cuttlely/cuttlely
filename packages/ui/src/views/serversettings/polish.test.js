import { CONFIRM_WORD, envExport, needsTypedConfirm, reviewRows } from './model'

const settings = [
    {
        key: 'CUTTLELY_ANALYST',
        label: 'Analyst storage',
        section: 'analyst',
        type: 'select',
        source: 'file',
        value: 'auto',
        risk: 'medium',
        options: []
    },
    {
        key: 'CORS_ORIGINS',
        label: 'Sites',
        section: 'security',
        type: 'list',
        source: 'file',
        value: 'https://orders.rosas-bakery.example',
        risk: 'high'
    },
    {
        key: 'APP_URL',
        label: 'Public address',
        section: 'advanced',
        type: 'text',
        source: 'file',
        value: 'https://flows.rosas bakery',
        risk: 'low'
    },
    {
        key: 'CUTTLELY_POSTGRES_URL',
        label: 'Separate Postgres',
        section: 'analyst',
        type: 'secret',
        source: 'file',
        secret: { set: true },
        risk: 'high'
    },
    { key: 'LOG_LEVEL', label: 'Log level', section: 'advanced', type: 'text', source: 'host', value: 'warn', risk: 'low' }
]

describe('polish', () => {
    it('asks for the word only when a change is high risk', () => {
        expect(CONFIRM_WORD).toBe('RESTART')
        expect(needsTypedConfirm(reviewRows(settings, { CUTTLELY_ANALYST: '' }))).toBe(false)
        expect(needsTypedConfirm(reviewRows(settings, { CORS_ORIGINS: '' }))).toBe(true)
        expect(needsTypedConfirm(reviewRows(settings, { CUTTLELY_POSTGRES_URL: 'postgres://made-up' }))).toBe(true)
    })

    it('copies saved values as .env, never a secret', () => {
        const text = envExport(settings)
        expect(text).toContain('CUTTLELY_ANALYST=auto\n')
        expect(text).toContain('CORS_ORIGINS=https://orders.rosas-bakery.example\n')
        expect(text).toContain('APP_URL="https://flows.rosas bakery"\n')
        expect(text).toContain('# CUTTLELY_POSTGRES_URL=  (secret')
        expect(text).not.toContain('LOG_LEVEL')
        expect(text).not.toContain('postgres://')
        expect(envExport([])).toContain('Nothing is saved here yet')
    })
})
