// Flow history is on by default in the app. Tests turn it on themselves when they need it.
if (process.env.CUTTLELY_VERSIONS === undefined) process.env.CUTTLELY_VERSIONS = 'off'

// Exercise the enforced access-key route matrix; rollout-specific tests override this explicitly.
process.env.INBOUND_ACCESS_V2 = 'on'
