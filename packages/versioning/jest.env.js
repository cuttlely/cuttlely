// Flow history is on by default in the app. Tests turn it on themselves when they need it.
if (process.env.CUTTLELY_VERSIONS === undefined) process.env.CUTTLELY_VERSIONS = 'off'
