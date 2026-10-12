import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ENCRYPTION_KEY_CONFLICT,
    encryptionKeyConflict,
    encryptionKeyOverwrite,
    fileSizeLimit,
    partnerIsSet,
    readSettingAlias,
    telemetryDisabled
} from './setting-alias.cjs'

const OLD_KEY = 'existing-name-value'
const NEW_KEY = 'product-name-value'

test('encryption key: existing name only, product name only, both equal, both different', () => {
    assert.equal(encryptionKeyOverwrite({ FLOWISE_SECRETKEY_OVERWRITE: OLD_KEY }), OLD_KEY)
    assert.equal(encryptionKeyOverwrite({ CUTTLELY_SECRETKEY_OVERWRITE: NEW_KEY }), NEW_KEY)
    assert.equal(encryptionKeyOverwrite({ FLOWISE_SECRETKEY_OVERWRITE: OLD_KEY, CUTTLELY_SECRETKEY_OVERWRITE: OLD_KEY }), OLD_KEY)
    assert.equal(
        encryptionKeyConflict({ FLOWISE_SECRETKEY_OVERWRITE: OLD_KEY, CUTTLELY_SECRETKEY_OVERWRITE: NEW_KEY }),
        ENCRYPTION_KEY_CONFLICT
    )
    assert.throws(
        () => encryptionKeyOverwrite({ FLOWISE_SECRETKEY_OVERWRITE: OLD_KEY, CUTTLELY_SECRETKEY_OVERWRITE: NEW_KEY }),
        (error) => error.code === 'ENCRYPTION_KEY_CONFLICT' && error.message === ENCRYPTION_KEY_CONFLICT && !error.message.includes(OLD_KEY)
    )
})

test('an empty encryption key name is unset and does not count as a different value', () => {
    assert.equal(encryptionKeyOverwrite({ CUTTLELY_SECRETKEY_OVERWRITE: '', FLOWISE_SECRETKEY_OVERWRITE: OLD_KEY }), OLD_KEY)
    assert.equal(encryptionKeyOverwrite({ CUTTLELY_SECRETKEY_OVERWRITE: NEW_KEY, FLOWISE_SECRETKEY_OVERWRITE: '' }), NEW_KEY)
    assert.equal(encryptionKeyOverwrite({}), undefined)
    assert.equal(encryptionKeyOverwrite({ FLOWISE_SECRETKEY_OVERWRITE: '  spaced  ' }), '  spaced  ')
})

test('file size and telemetry: product name wins when both are set', () => {
    assert.equal(fileSizeLimit({ FLOWISE_FILE_SIZE_LIMIT: '20mb' }), '20mb')
    assert.equal(fileSizeLimit({ CUTTLELY_FILE_SIZE_LIMIT: '10mb' }), '10mb')
    assert.equal(fileSizeLimit({ FLOWISE_FILE_SIZE_LIMIT: '20mb', CUTTLELY_FILE_SIZE_LIMIT: '10mb' }), '10mb')
    assert.equal(fileSizeLimit({}), '50mb')
    assert.equal(fileSizeLimit({ CUTTLELY_FILE_SIZE_LIMIT: '', FLOWISE_FILE_SIZE_LIMIT: '8mb' }), '8mb')

    assert.equal(telemetryDisabled({ DISABLE_FLOWISE_TELEMETRY: 'true' }), true)
    assert.equal(telemetryDisabled({ DISABLE_CUTTLELY_TELEMETRY: 'true' }), true)
    assert.equal(telemetryDisabled({ DISABLE_FLOWISE_TELEMETRY: 'true', DISABLE_CUTTLELY_TELEMETRY: 'false' }), false)
    assert.equal(telemetryDisabled({ DISABLE_FLOWISE_TELEMETRY: 'false', DISABLE_CUTTLELY_TELEMETRY: 'true' }), true)
    assert.equal(telemetryDisabled({}), false)
    assert.equal(telemetryDisabled({ DISABLE_CUTTLELY_TELEMETRY: '1' }), false)
})

test('readSettingAlias does not treat a blank partner as host-set', () => {
    assert.equal(
        readSettingAlias(
            { CUTTLELY_FILE_SIZE_LIMIT: '4mb', FLOWISE_FILE_SIZE_LIMIT: '9mb' },
            'CUTTLELY_FILE_SIZE_LIMIT',
            'FLOWISE_FILE_SIZE_LIMIT'
        ),
        '4mb'
    )
    assert.equal(partnerIsSet({ FLOWISE_FILE_SIZE_LIMIT: '9mb' }, 'CUTTLELY_FILE_SIZE_LIMIT'), true)
    assert.equal(partnerIsSet({ FLOWISE_FILE_SIZE_LIMIT: '' }, 'CUTTLELY_FILE_SIZE_LIMIT'), false)
    assert.equal(partnerIsSet({ FLOWISE_FILE_SIZE_LIMIT: '9mb' }, 'CUTTLELY_FILE_SIZE_LIMIT', ['FLOWISE_FILE_SIZE_LIMIT']), false)
})
