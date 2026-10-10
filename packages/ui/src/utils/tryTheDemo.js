// Key types most people already have come first in the Add a model key list.
export const POPULAR_KEY_TYPES = ['openAIApi', 'anthropicApi', 'xaiApi', 'googleGenerativeAI']

// The key to preselect: the one just added, else the only key that fits, else none.
export const defaultKey = (keys = [], added) =>
    added && keys.some((key) => key.id === added) ? added : keys.length === 1 ? keys[0].id : ''

// Saved keys the demo can run on: those whose type a chat model card takes.
export const usableKeys = (credentials = [], credentialNames = []) => {
    const fits = new Set(credentialNames)
    return credentials.filter((row) => fits.has(row.credentialName))
}

// Key types for the Add a model key list: only types a chat model card takes, popular ones first.
export const keyTypesForDemo = (components = [], credentialNames = []) => {
    const fits = new Set(credentialNames)
    const rank = (name) => (POPULAR_KEY_TYPES.includes(name) ? POPULAR_KEY_TYPES.indexOf(name) : POPULAR_KEY_TYPES.length)
    return components
        .filter((type) => fits.has(type.name))
        .sort((a, b) => rank(a.name) - rank(b.name) || String(a.label).localeCompare(String(b.label)))
}
