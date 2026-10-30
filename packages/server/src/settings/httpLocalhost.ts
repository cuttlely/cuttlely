// Lets HTTP building blocks read HTTP_ALLOW_LOCALHOST from Server settings on each request.
import { setHttpAllowLocalhostReader } from '@cuttlely/components'
import { httpAllowLocalhostFromSettings } from './httpLocalhostFlag'

export function installHttpLocalhostReader(): void {
    setHttpAllowLocalhostReader(httpAllowLocalhostFromSettings)
}
