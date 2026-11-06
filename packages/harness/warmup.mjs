// Process-local evidence: a successful request warms only its own compiled profile.
// A probe checks the shared runtime without claiming every profile is initialized.
export class WarmupCoordinator {
    constructor({ now = Date.now, recentMs = () => 300000 } = {}) {
        this.now = now
        this.recentMs = recentMs
        this.runtimes = new Map()
    }

    runtime(url) {
        const key = String(url).replace(/\/$/, '')
        if (!this.runtimes.has(key)) this.runtimes.set(key, { profiles: new Map(), active: 0, pending: null })
        return this.runtimes.get(key)
    }

    begin(url) {
        const runtime = this.runtime(url)
        runtime.active++
        return () => runtime.active--
    }

    succeeded(url, profile, version, at = this.now()) {
        this.runtime(url).profiles.set(profile, { version, at })
    }

    failed(url, profile) {
        this.runtime(url).profiles.delete(profile)
    }

    unavailable(url) {
        this.runtime(url).profiles.clear()
    }

    async run({ url, targets, healthy, warm }) {
        if (!targets.length) return []
        const runtime = this.runtime(url)
        // Queue concurrent saves/timers, then recheck evidence. Do not lose newly
        // saved profiles when another cycle was already warming a different roster.
        if (runtime.pending) {
            await runtime.pending.catch(() => {})
            return this.run({ url, targets, healthy, warm })
        }
        const pending = this.cycle(runtime, { url, targets, healthy, warm })
        runtime.pending = pending
        try {
            return await pending
        } finally {
            if (runtime.pending === pending) runtime.pending = null
        }
    }

    async cycle(runtime, { url, targets, healthy, warm }) {
        if (runtime.active) return []
        // Failed health invalidates evidence from the old runtime process.
        if (!(await healthy())) {
            runtime.profiles.clear()
            return []
        }
        if (runtime.active) return []
        const current = (target) => runtime.profiles.get(target.profile)?.version === target.version
        const cold = targets.filter((target) => !current(target))
        const recent = targets.some((target) => current(target) && this.now() - runtime.profiles.get(target.profile).at < this.recentMs())
        if (!cold.length && recent) return []
        const results = []
        const runOne = async (target) => {
            const result = await warm(target)
            results.push(result)
            if (result.status === 'warm') this.succeeded(url, target.profile, target.version)
            else this.failed(url, target.profile)
            return result.status === 'warm'
        }
        // Probe exactly one idle profile. On cold start that probe is also its
        // warm-up; do not pay for another run of the same specialist.
        const probe = cold[0] || targets[0]
        if (!recent && !(await runOne(probe))) return results
        const remaining = cold.filter((target) => recent || target !== probe)
        let cursor = 0
        const workers = await Promise.allSettled(
            Array.from({ length: Math.min(2, remaining.length) }, async () => {
                while (cursor < remaining.length && !runtime.active) {
                    const target = remaining[cursor++]
                    await runOne(target)
                }
            })
        )
        const failed = workers.find((worker) => worker.status === 'rejected')
        if (failed) throw failed.reason
        return results
    }
}

export const warmupCoordinator = new WarmupCoordinator({
    recentMs: () => {
        const minutes = Number(process.env.CUTTLELY_HERMES_KEEP_WARM_MINUTES)
        return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60000
    }
})
