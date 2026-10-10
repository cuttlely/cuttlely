import builderService from '../builder'

// The older generate route, kept for the embeddable agentflow package. It now runs the shared builder, so
// it gets the same strict check, repair round, credential matching and starter questions as Build with AI.
const generateAgentflowv2 = async (question: string, selectedChatModel: Record<string, any>, workspaceId: string) => {
    const result = await builderService.build('workflow', question, selectedChatModel as any, workspaceId)
    if (!result.ok) return { error: 'The workflow did not pass the check.', problems: result.problems }
    return result
}

export default {
    generateAgentflowv2
}
