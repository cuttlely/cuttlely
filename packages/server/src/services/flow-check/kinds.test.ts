import { startUnavailable, typeUnavailable } from './kinds'

const agentflow = (startInputType?: string) =>
    JSON.stringify({ nodes: [{ id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: { startInputType } } }], edges: [] })

describe('typeUnavailable', () => {
    test('chatflows and agentflows can be checked; a missing type is a chatflow', () => {
        expect(typeUnavailable('CHATFLOW')).toBeNull()
        expect(typeUnavailable('AGENTFLOW')).toBeNull()
        expect(typeUnavailable(undefined)).toBeNull()
        expect(typeUnavailable('AGENTFLOW', 'AGENTFLOW')).toBeNull()
        expect(typeUnavailable(null, 'CHATFLOW')).toBeNull()
    })

    test('legacy multi-agent flows and assistants cannot', () => {
        for (const type of ['MULTIAGENT', 'ASSISTANT']) {
            expect(typeUnavailable(type)).toEqual({ code: 'type', message: 'The check works on chatflows and agentflows.' })
        }
    })

    test('two versions of different kinds cannot be compared', () => {
        expect(typeUnavailable('AGENTFLOW', 'CHATFLOW')).toEqual({
            code: 'type',
            message: 'The check compares two versions of the same kind of flow.'
        })
    })
})

describe('startUnavailable', () => {
    test('only agentflows are looked at', () => {
        expect(startUnavailable('CHATFLOW', [agentflow('formInput')])).toBeNull()
    })

    test('an agentflow that starts with a chat message on both sides can be checked', () => {
        expect(startUnavailable('AGENTFLOW', [agentflow('chatInput'), agentflow('chatInput'), null])).toBeNull()
    })

    test('a form, webhook or schedule start on either side cannot', () => {
        for (const start of ['formInput', 'webhookTrigger', 'scheduleInput', undefined]) {
            expect(startUnavailable('AGENTFLOW', [agentflow('chatInput'), agentflow(start)])?.code).toBe('start')
        }
        expect(startUnavailable('AGENTFLOW', ['{"nodes":[]}'])?.message).toBe(
            'The check asks questions, so it works on agentflows that start with a chat message.'
        )
        expect(startUnavailable('AGENTFLOW', ['not json'])?.code).toBe('start')
    })
})
