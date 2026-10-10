// "Add these credentials on this server first: "OpenAI key" (openAIApi). Then promote again."
export function missingCredentialsMessage(missing: Array<{ name: string; credentialName: string }>): string {
    const list = missing.map((ref) => `"${ref.name}" (${ref.credentialName})`).join(', ')
    return `Add ${missing.length === 1 ? 'this credential' : 'these credentials'} on this server first: ${list}. Then promote again.`
}
