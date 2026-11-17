import { importVerifyPython } from './python'

describe('import verification Python', () => {
    test('uses the configured runtime Python', () => {
        expect(importVerifyPython({ HERMES_PYTHON: '/runtime/python' }, '/bundled/python', () => true)).toBe('/runtime/python')
    })

    test('uses the bundled runtime before the system Python', () => {
        expect(importVerifyPython({}, '/bundled/python', () => true)).toBe('/bundled/python')
        expect(importVerifyPython({}, '/bundled/python', () => false)).toBe('python3')
    })
})
