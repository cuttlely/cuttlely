import { ETL_LOAD_MESSAGE, ETL_SQLITE_MESSAGE, userFacingError } from './userFacingError'

describe('ETL user-facing errors', () => {
    it('replaces the node:sqlite builtin failure with a sentence', () => {
        const error = new Error('No such built-in module: node:sqlite')
        ;(error as NodeJS.ErrnoException).code = 'ERR_UNKNOWN_BUILTIN_MODULE'
        const text = userFacingError(error)
        expect(text).toBe(ETL_SQLITE_MESSAGE)
        expect(text).not.toMatch(/node:sqlite/)
        expect(text).not.toMatch(/\n\s+at /)
    })

    it('drops a stack dump', () => {
        const text = userFacingError(new Error('boom\n    at Module._load (node:internal/modules/cjs/loader:1:1)'))
        expect(text).toBe(ETL_LOAD_MESSAGE)
        expect(text).not.toMatch(/Module\._load/)
    })

    it('keeps an ordinary pipeline message', () => {
        expect(userFacingError(new Error('This ETL pipeline was not found in your workspace.'))).toBe(
            'This ETL pipeline was not found in your workspace.'
        )
    })
})
