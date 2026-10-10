export const AUTO_CREDENTIAL_NOTE = 'Auto mode: isolated analyst store, no credential needed'

export function credentialMarkOptional(inputParam, hint) {
    if (inputParam?.optional) return true
    return hint === AUTO_CREDENTIAL_NOTE
}

export function postgresCredentialHint(actions) {
    const list = Array.isArray(actions) ? actions : []
    const query = list.find((item) => item?.name === 'query' || String(item?.label || '').toUpperCase() === 'QUERY')
    if (String(query?.description || '').includes('isolated analyst store')) return AUTO_CREDENTIAL_NOTE
    return ''
}

export function selectedOptionDescriptions(options, value, multiple) {
    let names = []
    if (multiple) {
        if (Array.isArray(value)) names = value
        else if (typeof value === 'string' && value && value !== 'choose an option') {
            try {
                const parsed = JSON.parse(value)
                names = Array.isArray(parsed) ? parsed : []
            } catch {
                names = []
            }
        }
    } else if (value && value !== 'choose an option') {
        names = [value]
    }
    return (options || []).filter((option) => names.includes(option?.name) && option?.description).map((option) => option.description)
}
