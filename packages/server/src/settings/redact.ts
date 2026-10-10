/** Requests whose bodies may carry server setting secrets. The request logger never writes their bodies. */
export function isServerSettingsUrl(url: string): boolean {
    return /\/api\/v1\/server-settings(\/|\?|$)/i.test(url)
}
