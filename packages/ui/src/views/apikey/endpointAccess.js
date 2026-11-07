/** Translate only a known rollout mode into an endpoint access update. */
export const endpointAccessUpdate = (rollout, keyValue) => {
    if (!['off', 'shadow', 'on'].includes(rollout) || (rollout !== 'on' && keyValue === 'accesskeys')) return undefined
    return rollout === 'on'
        ? { apiAccessMode: keyValue ? 'private' : 'public', ...(keyValue ? {} : { apikeyid: '' }) }
        : { apikeyid: keyValue, apiAccessMode: keyValue ? 'private' : 'public' }
}

export const endpointAccessSelection = (rollout, mode, legacyId) =>
    mode === 'private' || (mode !== 'public' && legacyId) ? (rollout === 'on' || !legacyId ? 'accesskeys' : legacyId) : ''
