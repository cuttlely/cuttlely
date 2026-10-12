import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { databaseEntities } from '../../utils'
import logger from '../../utils/logger'
import credentialsService from '../credentials'
import harnessesService from '../harnesses'
import { BuildResult, runBuilder } from './core'
import { chatModelAsk, modelCredential } from './model'
import { BuilderKind, BuildingModel, CredentialSummary, Recipe } from './recipe'
import { chatRecipe } from './recipes/chat'
import { etlRecipe } from './recipes/etl'
import { harnessRecipe } from './recipes/harness'
import { workflowRecipe } from './recipes/workflow'

const MAX_REQUEST_CHARS = 4000

const recipes: Partial<Record<BuilderKind, Recipe>> = {
    workflow: workflowRecipe,
    harness: harnessRecipe,
    etl: etlRecipe,
    chat: chatRecipe
}

export const builderKinds = () => Object.keys(recipes) as BuilderKind[]

// Build with AI: one description in, an unsaved canvas out. The building model is the chat model the
// person picked, with a credential from their own workspace; there is no default key.
const build = async (kind: string, request: unknown, chatModel: BuildingModel | undefined, workspaceId: string): Promise<BuildResult> => {
    const recipe = recipes[kind as BuilderKind]
    if (!recipe) throw new AppError(StatusCodes.NOT_FOUND, `There is no builder for "${kind}".`)
    const description = typeof request === 'string' ? request.trim() : ''
    if (!description) throw new AppError(StatusCodes.BAD_REQUEST, 'Describe what to build.')
    if (description.length > MAX_REQUEST_CHARS)
        throw new AppError(StatusCodes.BAD_REQUEST, `Keep the description under ${MAX_REQUEST_CHARS} characters.`)
    if (!chatModel?.name) throw new AppError(StatusCodes.BAD_REQUEST, 'Pick the chat model that builds.')
    const credential = modelCredential(chatModel)
    if (!credential) throw new AppError(StatusCodes.BAD_REQUEST, 'Pick a credential for the chat model that builds.')
    await credentialsService.assertCredentialInWorkspace(credential, workspaceId)

    const appServer = getRunningExpressApp()
    const componentNodes = appServer.nodesPool.componentNodes as Record<string, any>
    const credentials: CredentialSummary[] = ((await credentialsService.getAllCredentials(undefined, workspaceId)) || []).map(
        (row: any) => ({ id: row.id, name: row.name, credentialName: row.credentialName })
    )
    const model: BuildingModel = { ...chatModel, credential, inputs: { ...(chatModel.inputs || {}), FLOWISE_CREDENTIAL_ID: credential } }
    const ask = await chatModelAsk(model, componentNodes, {
        appDataSource: appServer.AppDataSource,
        databaseEntities,
        logger,
        workspaceId
    })
    const credentialLabels: Record<string, string> = Object.fromEntries(
        Object.values((appServer.nodesPool.componentCredentials || {}) as Record<string, any>).map((c) => [c.name, c.label])
    )
    // A chatflow may attach a saved harness; the others never use one.
    const harnessNames: string[] =
        kind === 'chat'
            ? await harnessesService
                  .listHarnesses()
                  .then((list: any[]) => (list || []).map((harness) => String(harness?.name || '')).filter(Boolean))
                  .catch(() => [])
            : []
    const result = await runBuilder(
        recipe,
        description,
        { componentNodes, chatModel: model, credentials, credentialLabels, harnessNames },
        ask
    )
    logger.info(
        `[server]: Build with AI (${kind}) ${result.ok ? 'built' : 'did not pass the check'}${result.repaired ? ' after one repair' : ''}`
    )
    return result
}

export default { build }
