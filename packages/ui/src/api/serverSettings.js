import client from './client'

// Server settings: owner only. Secret values are sent, never received.
const getSettings = () => client.get('/server-settings')
const saveSettings = (values) => client.put('/server-settings', { values })
const discardChanges = () => client.post('/server-settings/discard')
const getHistory = (limit = 100) => client.get('/server-settings/history', { params: { limit } })
// wait: let chat and agent team runs in progress finish first (up to the turn time limit). false restarts now.
const restart = (wait = true) => client.post('/server-settings/restart', { wait })
// Safe boot set settings aside after two failed starts: put them back to try again at the next restart.
const retryRolledBack = () => client.post('/server-settings/retry')
// Tries the values on screen without saving them.
const testConnection = (kind, values) => client.post('/server-settings/test', { kind, values })

// Set up AuthKit: check the values, start a test sign-in, read its result, save what passed.
const checkAuthKit = (values) => client.post('/server-settings/authkit/check', { values })
const startAuthKitTest = (values) => client.post('/server-settings/authkit/test', { values })
const authKitTestStatus = () => client.get('/server-settings/authkit/test')
const applyAuthKitTest = (keepPassword) => client.post('/server-settings/authkit/apply', { keepPassword })
// Switch database: test and explain, switch (with RESTART typed), switch back.
const checkDatabase = (values) => client.post('/server-settings/database/check', { values })
const switchDatabase = (values, confirm) => client.post('/server-settings/database/switch', { values, confirm })
const restoreDatabase = (confirm) => client.post('/server-settings/database/restore', { confirm })

export default {
    getSettings,
    saveSettings,
    discardChanges,
    getHistory,
    restart,
    retryRolledBack,
    testConnection,
    checkAuthKit,
    startAuthKitTest,
    authKitTestStatus,
    applyAuthKitTest,
    checkDatabase,
    switchDatabase,
    restoreDatabase
}
