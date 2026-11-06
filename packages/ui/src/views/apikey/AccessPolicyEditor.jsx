import PropTypes from 'prop-types'
import { Alert, Box, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'

export const newAccessPolicy = () => ({
    version: 1,
    environment: 'live',
    service: '',
    allResources: false,
    scopes: [],
    rpm: 60,
    daily: 0,
    monthly: 0,
    origins: [],
    allowNoOrigin: true,
    ips: []
})

export default function AccessPolicyEditor({
    policy,
    setPolicy,
    resources,
    setResources,
    options,
    expiresAt,
    setExpiresAt,
    confirmed,
    setConfirmed
}) {
    const update = (name, value) => setPolicy((current) => ({ ...current, [name]: value }))
    const toggleScope = (scope) =>
        update('scopes', policy.scopes.includes(scope) ? policy.scopes.filter((s) => s !== scope) : [...policy.scopes, scope])
    return (
        <Stack spacing={2} sx={{ mt: 2 }}>
            {options.rollout && options.rollout !== 'on' && (
                <Alert severity='warning'>
                    Access key policy changes are unavailable while INBOUND_ACCESS_V2 is {options.rollout}. Review migration diagnostics and
                    enable the rollout before creating, rotating, or editing policies. Revocation stays available.
                </Alert>
            )}
            <Alert severity='info'>
                Access keys authorize inbound API and app requests. Provider credentials are outbound model and tool secrets, managed in
                Credentials. Keep access keys on your server. Public share and embed links have separate access settings.
            </Alert>
            {policy.legacy && (
                <Alert severity='warning'>
                    This key uses legacy compatibility. Saving an edited policy replaces compatibility with the explicit operations and
                    resources below. The existing secret continues to work until expiry, rotation grace, or revocation.
                </Alert>
            )}
            <TextField
                label='Service or application'
                value={policy.service}
                onChange={(e) => update('service', e.target.value)}
                inputProps={{ maxLength: 100 }}
            />
            <TextField
                select
                label='Environment label'
                value={policy.environment}
                onChange={(e) => update('environment', e.target.value)}
                helperText='Live/test is a label, not a separate workspace.'
            >
                <MenuItem value='live'>Live</MenuItem>
                <MenuItem value='test'>Test</MenuItem>
            </TextField>
            <TextField
                select
                label='Duration preset'
                value=''
                onChange={(e) =>
                    setExpiresAt(e.target.value === 'none' ? null : new Date(Date.now() + Number(e.target.value) * 86400000).toISOString())
                }
            >
                <MenuItem value=''>Choose a duration</MenuItem>
                <MenuItem value='30'>30 days</MenuItem>
                <MenuItem value='90'>90 days</MenuItem>
                <MenuItem value='none'>No expiry</MenuItem>
            </TextField>
            <TextField
                label='Expires at (UTC)'
                value={expiresAt ?? ''}
                placeholder='No expiry'
                onChange={(e) => setExpiresAt(e.target.value || null)}
                helperText='Absolute UTC timestamp, for example 2027-02-01T00:00:00.000Z. No sliding renewal.'
            />
            <Stack direction='row' spacing={1}>
                {['rpm', 'daily', 'monthly'].map((field) => (
                    <TextField
                        key={field}
                        type='number'
                        label={{ rpm: 'Requests per minute', daily: 'Daily UTC quota', monthly: 'Monthly UTC quota' }[field]}
                        value={policy[field]}
                        inputProps={{ min: 0, max: 1000000000 }}
                        onChange={(e) => update(field, Number(e.target.value))}
                        helperText='0 = unlimited'
                    />
                ))}
            </Stack>
            <Typography variant='h5'>API operations</Typography>
            <Typography variant='body2'>
                Operations and workspace permissions must both allow a request. Management operations never grant prediction or Harness
                execution.
            </Typography>
            <Typography variant='body2'>
                API write edits names and categories only. Sign in to change canvases, schedules, publication or execution transports.
            </Typography>
            <Box>
                {(options.scopes || []).map((scope) => (
                    <FormControlLabel
                        key={scope}
                        control={<Checkbox checked={policy.scopes.includes(scope)} onChange={() => toggleScope(scope)} />}
                        label={scope}
                    />
                ))}
            </Box>
            <Typography variant='h5'>Resources this key may access</Typography>
            <Typography variant='body2'>
                New keys access no resources. A flow that calls a Harness also requires that Harness and harness:run. Granting a resource
                does not make a public flow private; use the flow’s API access setting.
            </Typography>
            {options.canGrantAll && (
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={policy.allResources}
                            onChange={(e) => {
                                update('allResources', e.target.checked)
                                setConfirmed(false)
                            }}
                        />
                    }
                    label='All resources in this workspace, including future resources'
                />
            )}
            {policy.allResources && (
                <Alert severity='warning'>
                    <FormControlLabel
                        control={<Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />}
                        label='I confirm this privileged workspace-wide resource grant. Operation and caller restrictions still apply.'
                    />
                </Alert>
            )}
            {!policy.allResources &&
                ['CHATFLOW', 'AGENTFLOW', 'HARNESS', 'DASHFLOW'].map((type) => (
                    <Box key={type}>
                        <Typography variant='subtitle1'>
                            {{ CHATFLOW: 'Chatflows', AGENTFLOW: 'Agentflows', HARNESS: 'Harnesses', DASHFLOW: 'Dashflows' }[type]}
                        </Typography>
                        {(options.resources || [])
                            .filter((r) => r.resourceType === type)
                            .map((r) => {
                                const selected = resources.some((g) => g.resourceType === type && g.resourceId === r.resourceId)
                                return (
                                    <Box key={r.resourceId}>
                                        <FormControlLabel
                                            control={
                                                <Checkbox
                                                    checked={selected}
                                                    onChange={() =>
                                                        setResources(
                                                            selected
                                                                ? resources.filter(
                                                                      (g) => !(g.resourceType === type && g.resourceId === r.resourceId)
                                                                  )
                                                                : [...resources, { resourceType: type, resourceId: r.resourceId }]
                                                        )
                                                    }
                                                />
                                            }
                                            label={r.name}
                                        />
                                        {r.requiredHarnesses?.length > 0 && (
                                            <Typography variant='caption'>
                                                Requires Harness grants: {r.requiredHarnesses.join(', ')}
                                            </Typography>
                                        )}
                                    </Box>
                                )
                            })}
                    </Box>
                ))}
            <TextField
                label='Allowed origins (one per line)'
                multiline
                minRows={2}
                value={policy.origins.join('\n')}
                onChange={(e) =>
                    setPolicy((current) => ({
                        ...current,
                        origins: e.target.value.split('\n'),
                        allowNoOrigin: current.origins.filter(Boolean).length ? current.allowNoOrigin : false
                    }))
                }
                helperText='Exact HTTP(S) origins. Empty list allows any origin. No wildcards or Referer fallback.'
            />
            <FormControlLabel
                control={<Checkbox checked={policy.allowNoOrigin} onChange={(e) => update('allowNoOrigin', e.target.checked)} />}
                label='Allow server callers without an Origin header'
            />
            <TextField
                label='Allowed IP addresses or CIDRs (one per line)'
                multiline
                minRows={2}
                value={policy.ips.join('\n')}
                onChange={(e) => update('ips', e.target.value.split('\n'))}
                helperText='Empty list allows any IP. Uses the server’s trusted proxy configuration.'
            />
            <Alert severity={policy.allResources || resources.length ? 'info' : 'warning'}>
                Policy preview: {policy.scopes.length} operations;{' '}
                {policy.allResources ? 'all current and future resources in this workspace' : `${resources.length} selected resources`};{' '}
                {expiresAt ? `expires ${expiresAt}` : 'no expiry'}.{' '}
                {policy.scopes.length === 0 || (!policy.allResources && resources.length === 0)
                    ? 'This key cannot execute requests yet.'
                    : 'Each request must also pass workspace permissions and caller restrictions.'}
            </Alert>
        </Stack>
    )
}
AccessPolicyEditor.propTypes = {
    policy: PropTypes.object.isRequired,
    setPolicy: PropTypes.func.isRequired,
    resources: PropTypes.array.isRequired,
    setResources: PropTypes.func.isRequired,
    options: PropTypes.object.isRequired,
    expiresAt: PropTypes.string,
    setExpiresAt: PropTypes.func.isRequired,
    confirmed: PropTypes.bool.isRequired,
    setConfirmed: PropTypes.func.isRequired
}
