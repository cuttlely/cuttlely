import { datasetStartRefusal, startUnavailable, triggerStart, typeUnavailable } from './kinds'

const agentflow = (startInputType?: string) =>
    JSON.stringify({ nodes: [{ id: 'startAgentflow_0', data: { name: 'startAgentflow', inputs: { startInputType } } }], edges: [] })

describe('typeUnavailable', () => {
    test('chatflows, agentflows and harnesses can be checked; a missing type is a chatflow', () => {
        expect(typeUnavailable('CHATFLOW')).toBeNull()
        expect(typeUnavailable('AGENTFLOW')).toBeNull()
        expect(typeUnavailable('HARNESS')).toBeNull()
        expect(typeUnavailable(undefined)).toBeNull()
        expect(typeUnavailable('AGENTFLOW', 'AGENTFLOW')).toBeNull()
        expect(typeUnavailable('HARNESS', 'HARNESS')).toBeNull()
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

    test('a form, webhook or schedule start can be checked when both sides use it', () => {
        for (const start of ['formInput', 'webhookTrigger', 'scheduleInput'] as const) {
            expect(startUnavailable('AGENTFLOW', [agentflow(start), agentflow(start)])).toBeNull()
            expect(triggerStart('AGENTFLOW', [agentflow(start), agentflow(start), null])).toBe(start)
        }
        // A canvas with no Start node does not block the side that has the trigger.
        expect(startUnavailable('AGENTFLOW', ['{"nodes":[]}', agentflow('webhookTrigger')])).toBeNull()
    })

    test('mixed starts, a blank start and a canvas with no start still cannot', () => {
        for (const start of ['formInput', 'webhookTrigger', 'scheduleInput', undefined]) {
            expect(startUnavailable('AGENTFLOW', [agentflow('chatInput'), agentflow(start)])?.code).toBe('start')
        }
        expect(startUnavailable('AGENTFLOW', [agentflow('formInput'), agentflow('webhookTrigger')])?.code).toBe('start')
        expect(triggerStart('AGENTFLOW', [agentflow('chatInput')])).toBeNull()
        expect(startUnavailable('AGENTFLOW', ['{"nodes":[]}'])?.message).toBe(
            'The check asks questions, so it works on agentflows that start with a chat message.'
        )
        expect(startUnavailable('AGENTFLOW', ['not json'])?.code).toBe('start')
    })
})

describe('datasetStartRefusal', () => {
    test('a chatflow, a harness, and an agentflow that starts with a chat message, can use a dataset', () => {
        expect(datasetStartRefusal('CHATFLOW', [agentflow('formInput')])).toBeNull()
        expect(datasetStartRefusal('HARNESS', ['{"nodes":[]}', null])).toBeNull()
        expect(datasetStartRefusal('AGENTFLOW', [agentflow('chatInput'), agentflow('chatInput')])).toBeNull()
    })

    test('a form, webhook or schedule start is named in the refusal', () => {
        expect(datasetStartRefusal('AGENTFLOW', [agentflow('formInput')])).toContain('starts with a form')
        expect(datasetStartRefusal('AGENTFLOW', [agentflow('chatInput'), agentflow('webhookTrigger')])).toContain('starts with a webhook')
        expect(datasetStartRefusal('AGENTFLOW', [agentflow('scheduleInput')])).toContain('starts with a schedule')
    })
})
