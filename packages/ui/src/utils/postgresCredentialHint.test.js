import { AUTO_CREDENTIAL_NOTE, credentialMarkOptional, postgresCredentialHint, selectedOptionDescriptions } from './postgresCredentialHint'

describe('postgres credential hint', () => {
    it('says auto mode needs no credential when the action describes the isolated store', () => {
        expect(
            postgresCredentialHint([
                { name: 'query', label: 'QUERY', description: 'Run one SQL statement in the isolated analyst store (SQLite).' }
            ])
        ).toBe(AUTO_CREDENTIAL_NOTE)
    })

    it('drops the required mark in analyst auto mode', () => {
        expect(credentialMarkOptional({ optional: false }, AUTO_CREDENTIAL_NOTE)).toBe(true)
        expect(credentialMarkOptional({ optional: false }, '')).toBe(false)
        expect(credentialMarkOptional({ optional: true }, '')).toBe(true)
    })

    it('keeps the warning when the action is a real Postgres query', () => {
        expect(postgresCredentialHint([{ name: 'query', description: 'Run a read-only SQL query' }])).toBe('')
        expect(postgresCredentialHint([])).toBe('')
    })

    it('shows the selected action description under the field', () => {
        const options = [{ name: 'query', description: 'Run one SQL statement in the isolated analyst store (SQLite).' }]
        expect(selectedOptionDescriptions(options, '["query"]', true)).toEqual([
            'Run one SQL statement in the isolated analyst store (SQLite).'
        ])
        expect(selectedOptionDescriptions(options, 'choose an option', true)).toEqual([])
    })
})
