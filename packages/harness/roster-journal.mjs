import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { isPackagedOpsStatus } from './runtime/native-mcp.mjs'
import { specialistSessionId } from './specialist-run.mjs'

const components = createRequire(new URL('../components/package.json', import.meta.url))
const modelClasses = new Set(
    components('@cuttlely/components/module-catalog')
        .nodes.filter((n) => n.category === 'Chat Models')
        .map((n) => n.name)
)
const modelOptions = new Set([
    'modelName',
    'temperature',
    'maxTokens',
    'maxOutputTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'streaming'
])

function directModel(model) {
    return (
        modelClasses.has(model?.nodeName) &&
        !Object.keys(model.upstream || {}).length &&
        Object.entries(model.inputs || {}).every(
            ([key, value]) => modelOptions.has(key) && ['string', 'boolean', 'number'].includes(typeof value)
        )
    )
}

// Version 8 UUIDs identify this application-specific turn-id format. Other engines use random v4 IDs.
export function journalSession(id) {
    return typeof id === 'string' && /#turn-[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
}

export function journalTeam(record) {
    return Boolean(
        record?.workspaceId &&
            record.chatflowId &&
            record.createdAt &&
            record.updatedAt &&
            !record.tryId &&
            directModel(record.chief?.model) &&
            (!record.chief?.fallbackModel || directModel(record.chief.fallbackModel)) &&
            record.specialists?.length &&
            record.specialists.every(
                (role) =>
                    (!role.model || directModel(role.model)) &&
                    (!role.fallbackModel || directModel(role.fallbackModel)) &&
                    !role.preset &&
                    !role.shell &&
                    !role.browser &&
                    !role.codeExecution &&
                    !role.fileAccess &&
                    !role.modules?.length &&
                    !role.playbooks?.length &&
                    !role.trustedOutputs?.length &&
                    !Object.keys(role.credentials || {}).length &&
                    (role.mcpServers || []).every(isPackagedOpsStatus)
            )
    )
}

export function journalTurnId(owner, record, chatId) {
    const key = [
        record.workspaceId,
        record.chatflowId,
        record.createdAt,
        record.updatedAt,
        record.name,
        chatId,
        record.chief,
        record.specialists
    ]
    const hex = createHmac('sha256', owner)
        .update(JSON.stringify(['bundled-roster-journal-v1', ...key]))
        .digest('hex')
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        '8' + hex.slice(13, 16),
        ((parseInt(hex[16], 16) & 3) | 8).toString(16) + hex.slice(17, 20),
        hex.slice(20, 32)
    ].join('-')
}

export function matchesJournalTurn(owner, record, chatId, turnId, sessionId) {
    return owner && journalTurnId(owner, record, chatId) === turnId && sessionId === specialistSessionId(record.name, chatId, turnId)
}
