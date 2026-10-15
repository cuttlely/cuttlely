import express from 'express'
import agentflowv2GeneratorRouter from './agentflowv2-generator'
import apikeyRouter from './apikey'
import builderRouter from './builder'
import assistantsRouter from './assistants'
import attachmentsRouter from './attachments'
import chatMessageRouter from './chat-messages'
import chatflowsRouter from './chatflows'
import demoRouter from './demo'
import chatflowsStreamingRouter from './chatflows-streaming'
import chatflowsUploadsRouter from './chatflows-uploads'
import componentsCredentialsRouter from './components-credentials'
import componentsCredentialsIconRouter from './components-credentials-icon'
import credentialsRouter from './credentials'
import customMcpServersRouter from './custom-mcp-servers'
import datasetRouter from './dataset'
import documentStoreRouter from './documentstore'
import evaluationsRouter from './evaluations'
import evaluatorsRouter from './evaluator'
import executionsRouter from './executions'
import exportImportRouter from './export-import'
import feedbackRouter from './feedback'
import fetchLinksRouter from './fetch-links'
import flowConfigRouter from './flow-config'
import getUploadFileRouter from './get-upload-file'
import internalChatmessagesRouter from './internal-chat-messages'
import internalPredictionRouter from './internal-predictions'
import leadsRouter from './leads'
import logRouter from './log'
import loadPromptRouter from './load-prompts'
import marketplacesRouter from './marketplaces'
import mcpEndpointRouter from './mcp-endpoint'
import mcpServerRouter from './mcp-server'
import nodeConfigRouter from './node-configs'
import nodeCustomFunctionRouter from './node-custom-functions'
import nodeIconRouter from './node-icons'
import nodeLoadMethodRouter from './node-load-methods'
import nodesRouter from './nodes'
import nvidiaNimRouter from './nvidia-nim'
import oauth2Router from './oauth2'
import openaiAssistantsRouter from './openai-assistants'
import openaiAssistantsFileRouter from './openai-assistants-files'
import openaiAssistantsVectorStoreRouter from './openai-assistants-vector-store'
import openaiRealtimeRouter from './openai-realtime'
import pingRouter from './ping'
import predictionRouter from './predictions'
import promptListsRouter from './prompts-lists'
import publicChatbotRouter from './public-chatbots'
import publicChatflowsRouter from './public-chatflows'
import publicExecutionsRouter from './public-executions'
import settingsRouter from './settings'
import serverSettingsRouter from './server-settings'
import serverSetupRouter from './server-setup'
import { trackRuns } from '../settings/runs'
import modelPricesRouter from './model-prices'
import statsRouter from './stats'
import textToSpeechRouter from './text-to-speech'
import toolsRouter from './tools'
import upsertHistoryRouter from './upsert-history'
import validationRouter from './validation'
import variablesRouter from './variables'
import vectorRouter from './vectors'
import verifyRouter from './verify'
import versionRouter from './versions'
import webhookRouter from './webhook'
import webhookListenerRouter from './webhook-listener'

import harnessesRouter from './harnesses'
import flowVersionsRouter from './flow-versions'
import flowDraftsRouter from './flow-drafts'
import etlRouter from './etl'
import {
    identityAccountRouter,
    identityAuthRouter,
    identityOrgUserRouter,
    identityRoleRouter,
    identityRolesRouter,
    identityUserRouter,
    identityUsersRouter,
    identityWorkspaceRouter,
    identityWorkspaceUserRouter,
    identityAuditRouter
} from '../identity'
import { closedRouter, denyClosedFeature } from '../identity/ossPlatform'

const router = express.Router()

// Runs in progress are counted so Restart can let them finish (settings/runs.ts).
router.use(trackRuns)

router.use('/ping', pingRouter)
router.use('/apikey', apikeyRouter)
router.use('/assistants', assistantsRouter)
router.use('/attachments', attachmentsRouter)
router.use('/chatflows', chatflowsRouter)
router.use('/demo', demoRouter)
router.use('/harnesses', harnessesRouter)
router.use('/flow-versions', flowVersionsRouter)
router.use('/flow-drafts', flowDraftsRouter)
router.use('/etl', etlRouter)
router.use('/chatflows-streaming', chatflowsStreamingRouter)
router.use('/chatmessage', chatMessageRouter)
router.use('/chatflows-uploads', chatflowsUploadsRouter)
router.use('/components-credentials', componentsCredentialsRouter)
router.use('/components-credentials-icon', componentsCredentialsIconRouter)
router.use('/credentials', credentialsRouter)
router.use('/datasets', denyClosedFeature('feat:datasets'), datasetRouter)
router.use('/document-store', documentStoreRouter)
router.use('/evaluations', denyClosedFeature('feat:evaluations'), evaluationsRouter)
router.use('/evaluators', denyClosedFeature('feat:evaluators'), evaluatorsRouter)
router.use('/export-import', exportImportRouter)
router.use('/feedback', feedbackRouter)
router.use('/fetch-links', fetchLinksRouter)
router.use('/flow-config', flowConfigRouter)
router.use('/internal-chatmessage', internalChatmessagesRouter)
router.use('/internal-prediction', internalPredictionRouter)
router.use('/get-upload-file', getUploadFileRouter)
router.use('/leads', leadsRouter)
router.use('/load-prompt', loadPromptRouter)
router.use('/marketplaces', marketplacesRouter)
router.use('/node-config', nodeConfigRouter)
router.use('/node-custom-function', nodeCustomFunctionRouter)
router.use('/node-icon', nodeIconRouter)
router.use('/node-load-method', nodeLoadMethodRouter)
router.use('/nodes', nodesRouter)
router.use('/oauth2-credential', oauth2Router)
router.use('/openai-assistants', openaiAssistantsRouter)
router.use('/openai-assistants-file', openaiAssistantsFileRouter)
router.use('/openai-assistants-vector-store', openaiAssistantsVectorStoreRouter)
router.use('/openai-realtime', openaiRealtimeRouter)
router.use('/prediction', predictionRouter)
router.use('/prompts-list', promptListsRouter)
router.use('/public-chatbotConfig', publicChatbotRouter)
router.use('/public-chatflows', publicChatflowsRouter)
router.use('/public-executions', publicExecutionsRouter)
router.use('/stats', statsRouter)
router.use('/model-prices', modelPricesRouter)
router.use('/tools', toolsRouter)
router.use('/variables', variablesRouter)
router.use('/vector', vectorRouter)
router.use('/verify', verifyRouter)
router.use('/webhook', webhookRouter)
router.use('/webhook-listener', webhookListenerRouter)
router.use('/version', versionRouter)
router.use('/upsert-history', upsertHistoryRouter)
router.use('/settings', settingsRouter)
router.use('/server-settings', serverSettingsRouter)
router.use('/server-setup', serverSetupRouter)
router.use('/pricing', closedRouter())
router.use('/nvidia-nim', nvidiaNimRouter)
router.use('/executions', executionsRouter)
router.use('/validation', validationRouter)
router.use('/agentflowv2-generator', agentflowv2GeneratorRouter)
router.use('/builder', builderRouter)
router.use('/text-to-speech', textToSpeechRouter)
router.use('/custom-mcp-servers', customMcpServersRouter)
router.use('/mcp-server', mcpServerRouter)
router.use('/mcp', mcpEndpointRouter)

// Teams, users, and roles are the identity directory. Auth and account do not
// fall through to a commercial router. Export and import answer 404.
router.use('/auth', identityAuthRouter)
router.use('/account', identityAccountRouter)
router.use('/user', identityUserRouter)
router.use('/users', identityUsersRouter)
router.use('/role', identityRoleRouter)
router.use('/roles', identityRolesRouter)
router.use('/organizationuser', identityOrgUserRouter)
router.use('/workspace', identityWorkspaceRouter)
router.use('/workspaceuser', identityWorkspaceUserRouter)
router.use('/audit', identityAuditRouter)
router.use('/organization', closedRouter())
router.use('/loginmethod', closedRouter())
router.use('/logs', logRouter)

export default router
