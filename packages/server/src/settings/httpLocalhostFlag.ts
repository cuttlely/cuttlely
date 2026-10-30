// The live value of HTTP_ALLOW_LOCALHOST for HTTP building blocks, read on each request.
// It is the runtime switch: a valid host value, then the saved settings file, then off. No restart.
import { runtimeFlag } from './runtime'

export function httpAllowLocalhostFromSettings(): boolean {
    return runtimeFlag('HTTP_ALLOW_LOCALHOST').value
}
