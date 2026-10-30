export const AUDIT_TYPES = [
    { value: '', label: 'All types' },
    { value: 'sign_in_success', label: 'Sign-in succeeded' },
    { value: 'sign_in_failure', label: 'Sign-in failed' },
    { value: 'lockout', label: 'Sign-in locked' },
    { value: 'invite', label: 'Invite' },
    { value: 'reset', label: 'Password reset' },
    { value: 'role_change', label: 'Role changed' },
    { value: 'user_disable', label: 'User disabled or enabled' },
    { value: 'setting_change', label: 'Settings changed' },
    { value: 'harness_run', label: 'Harness run from the API' },
    { value: 'harness_access', label: 'API key harness access' },
    { value: 'harness_schedule', label: 'Harness schedule' },
    { value: 'pinned_query_change', label: 'Pinned query change' },
    { value: 'auth_method_change', label: 'Sign-in method changed' },
    { value: 'auth_config_warning_ack', label: 'Authentication warning acknowledged' }
]

export function auditParams({ type, user, cursor } = {}) {
    const params = {}
    if (type) params.type = type
    if (user && String(user).trim()) params.user = String(user).trim()
    if (cursor) params.cursor = cursor
    return params
}
