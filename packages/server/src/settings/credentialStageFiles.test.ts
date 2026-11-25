import { AES } from 'crypto-js'
import { forCredentialGeneration, newCredentialGeneration } from './credentialEnvelope'
import { stageAnalystRoleFiles, stageSettingsDocuments } from './credentialStageFiles'

test('stages saved and recovery settings, preserving the original documents for rollback', () => {
    const key = 'old fixture key'
    const destination = forCredentialGeneration('new fixture key', newCredentialGeneration())
    const legacy = JSON.stringify({
        version: 1,
        keyCheck: AES.encrypt('server-settings-key-check', key).toString(),
        values: { DATABASE_PASSWORD: { secret: AES.encrypt('old database password', key).toString() }, LOG_LEVEL: 'info' }
    })
    const documents = new Map([
        ['server.json', legacy],
        ['server.last-good.json', legacy],
        ['authkit-test.json', JSON.stringify({ fingerprint: '1'.repeat(64) })],
        ['instance-operator.json', '{"state":"active"}']
    ])
    const plan = stageSettingsDocuments(documents, { passphrase: key }, destination)
    expect(plan.rewrapped).toBe(4)
    expect(plan.requiresRetest).toBe(1)
    expect(plan.staged.has('authkit-test.json')).toBe(false)
    expect(documents.has('authkit-test.json')).toBe(true)
    expect(documents.get('server.json')).toBe(legacy)
    expect(plan.staged.get('instance-operator.json')).toBe(documents.get('instance-operator.json'))
    for (const name of ['server.json', 'server.last-good.json']) {
        const { values, keyCheck } = JSON.parse(plan.staged.get(name)!)
        expect(values.LOG_LEVEL).toBe('info')
        expect(destination.open(keyCheck, ['server-settings', 'key-check'])).toBe('server-settings-key-check')
        expect(destination.open(values.DATABASE_PASSWORD.secret, ['server-setting', 'DATABASE_PASSWORD'])).toBe('old database password')
    }
    expect(() => stageSettingsDocuments(new Map([['unknown.json', '{}']]), { passphrase: key }, destination)).toThrow()
})

test('keeps the Analyst role password and rejects a mismatched role file', () => {
    const oldKey = 'original analyst fixture key'
    const next = forCredentialGeneration('replacement analyst fixture key', newCredentialGeneration())
    const role = { role: 'analyst_reader', password: 'existing analyst password' }
    const original = AES.encrypt(JSON.stringify(role), oldKey).toString()
    const input = new Map([['analyst-role.enc', original]])
    const staged = stageAnalystRoleFiles(input, { passphrase: ' ' + oldKey + ' ' }, next)
    expect(JSON.parse(next.open(staged.get('analyst-role.enc')!, ['analyst-role', role.role]))).toEqual(role)
    expect(input.get('analyst-role.enc')).toBe(original)
    expect(() => stageAnalystRoleFiles(new Map([['analyst-role-0123456789.enc', original]]), { passphrase: oldKey }, next)).toThrow()
})
