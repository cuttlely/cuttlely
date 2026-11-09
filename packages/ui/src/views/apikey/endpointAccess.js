/** Translate only a known rollout mode into an endpoint access update. */
export const endpointAccessUpdate = (rollout, keyValue) => {
    if (!['off', 'shadow', 'on'].includes(rollout) || (rollout !== 'on' && keyValue === 'accesskeys')) return undefined
    return rollout === 'on'
        ? { apiAccessMode: keyValue ? 'private' : 'public', ...(keyValue ? {} : { apikeyid: '' }) }
        : { apikeyid: keyValue, apiAccessMode: keyValue ? 'private' : 'public' }
}

export const endpointAccessSelection = (rollout, mode, legacyId) =>
    mode === 'private' || (mode !== 'public' && legacyId) ? (rollout === 'on' || !legacyId ? 'accesskeys' : legacyId) : ''

export function accessKeyExamples(origin, resource, readOnly = false) {
    const url = `${origin}/api/v1/${readOnly ? 'chatflows' : 'prediction'}/${encodeURIComponent(resource.resourceId)}`
    return {
        curl: `curl ${JSON.stringify(url)} \\\n  -H "Authorization: Bearer $CUTTLELY_API_KEY"${
            readOnly ? '' : ` \\\n  -H "Content-Type: application/json" \\\n  -d '{"question":"Hello"}'`
        }`,
        javascript: `const response = await fetch(${JSON.stringify(url)}, {\n    method: '${
            readOnly ? 'GET' : 'POST'
        }',\n    headers: {\n        Authorization: \`Bearer \${process.env.CUTTLELY_API_KEY}\`,\n        'Content-Type': 'application/json'\n    }${
            readOnly ? '' : `,\n    body: JSON.stringify({ question: 'Hello' })`
        }\n})\nif (!response.ok) throw new Error(await response.text())\nconsole.log(await response.json())`
    }
}
