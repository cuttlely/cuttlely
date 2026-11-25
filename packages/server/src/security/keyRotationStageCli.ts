import '../settings/loadServerEnv'
import { stageCredentialRotation } from './keyRotationStage'

void stageCredentialRotation(process.env).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'),
    () => {
        process.stdout.write(JSON.stringify({ phase: 'blocked', code: 'ROTATION_STAGING_FAILED' }) + '\n')
        process.exitCode = 1
    }
)
