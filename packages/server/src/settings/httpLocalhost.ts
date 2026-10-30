// Lets HTTP building blocks read HTTP_ALLOW_LOCALHOST from Server settings on each request.
// The value is the runtime switch: a valid host value, then the saved settings file, then off. No restart.
import { HTTP_ALLOW_LOCALHOST, setHttpAllowLocalhostReader } from '@cuttlely/components'
import { runtimeFlag } from './runtime'

export function installHttpLocalhostReader(): void {
    setHttpAllowLocalhostReader(() => runtimeFlag(HTTP_ALLOW_LOCALHOST).value)
}
