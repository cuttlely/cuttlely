export function dashFlowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CUTTLELY_DASH_FLOWS === '1' || env.CUTTLELY_DASH_FLOWS === 'true'
}
