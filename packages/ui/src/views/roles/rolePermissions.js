// The role dialog used to walk Object.keys and destructure each key string, so every
// checkbox looked enabled and the save wrote `${category}:view`. Users and Roles have
// no view key, and the server rejects users:view and roles:view.

export function togglePermission(category, selected, key, categoryKeys) {
    const updated = { ...(selected || {}), [key]: !selected?.[key] }
    const keys = categoryKeys || []

    if (category === 'templates') {
        if (key !== 'templates:marketplace' && key !== 'templates:custom') {
            updated['templates:marketplace'] = true
            updated['templates:custom'] = true
        }
        return updated
    }

    const viewKey = `${category}:view`
    if (!keys.includes(viewKey) || key === viewKey) return updated

    const otherOn = Object.entries(updated).some(([permissionKey, isEnabled]) => permissionKey !== viewKey && isEnabled)
    if (otherOn) updated[viewKey] = true
    return updated
}

export function enabledPermissionKeys(selectedByCategory) {
    const keys = []
    for (const category of Object.keys(selectedByCategory || {})) {
        for (const [key, isEnabled] of Object.entries(selectedByCategory[category] || {})) {
            if (isEnabled) keys.push(key)
        }
    }
    return keys
}
