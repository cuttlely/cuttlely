jest.mock('../settings/bootstrap', () => ({ startState: { ignored: false, applied: [], problems: [], dir: undefined } }))
jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

import HashPassword from './hash-password'

describe('hash-password command', () => {
    it('never fills the file argument from piped input, which is the password', () => {
        // oclif reads a missing argument from a pipe unless told not to. `run hash-password < password-file`
        // would otherwise take the password as the file name and hash an empty string.
        expect(HashPassword.args.file.ignoreStdin).toBe(true)
        expect(HashPassword.flags.output).toBeDefined()
    })
})
