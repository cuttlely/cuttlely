// METRICS_PREFIX is opt-in. Unset or empty keeps the metric names published today.
const HISTORICAL_NODE_PREFIX = 'flowise_'

export function metricsPrefix(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const value = env.METRICS_PREFIX
    if (value === undefined || value === '') return undefined
    return value
}

export function nodeMetricsPrefix(env: NodeJS.ProcessEnv = process.env): string {
    return metricsPrefix(env) ?? HISTORICAL_NODE_PREFIX
}

/** Today's name, or that name under METRICS_PREFIX when the variable is set. */
export function metricName(base: string, env: NodeJS.ProcessEnv = process.env): string {
    const prefix = metricsPrefix(env)
    if (prefix === undefined) return base
    if (base.startsWith(HISTORICAL_NODE_PREFIX)) return prefix + base.slice(HISTORICAL_NODE_PREFIX.length)
    return prefix + base
}
