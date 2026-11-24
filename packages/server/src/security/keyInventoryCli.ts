import '../settings/loadServerEnv'
import { inventoryCredentialKey } from './keyInventory'

void inventoryCredentialKey(process.env).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.status === 'blocked') process.exitCode = 1
})
