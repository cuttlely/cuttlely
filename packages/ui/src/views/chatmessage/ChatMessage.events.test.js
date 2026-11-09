import React from 'react'
import PropTypes from 'prop-types'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { transformSync } from '@babel/core'
import { resolveShowToolEvents } from '@/utils/toolEvents'

// Render the actual message-status JSX with leaf cards substituted. This keeps the
// regression independent of the chat composer's microphone, upload and model APIs.
const source = readFileSync(join(__dirname, 'ChatMessage.jsx'), 'utf8')
const jsx = source.slice(source.indexOf('{message.harnessTrace ? ('), source.indexOf('{message.artifacts && ('))
const compiled = transformSync(
    `module.exports = (context) => { const {
    showToolEvents, message, messages = [], index = 0, chatflowid, chatId,
    customization, isDialog, onSourceDialogClick, renderArtifacts,
    agentReasoningArtifacts, getAgentIcon, removeDuplicateURL, isValidURL,
    onURLClick, getLabel, enhancedStatusMessages
} = context; return <>${jsx}</> }`,
    {
        configFile: false,
        babelrc: false,
        presets: [['@babel/preset-react', { runtime: 'classic' }]]
    }
).code
const dependencies = {
    React,
    HarnessRunTrace: () => <div>Harness run card</div>,
    previousUserQuestion: () => 'question',
    AgentReasoningCard: () => <div>Agent reasoning card</div>,
    AgentExecutedDataCard: () => <div>Agent execution card</div>,
    Chip: ({ label }) => <span>{label}</span>,
    CircularProgress: () => null,
    IconTool: () => null,
    alpha: () => '',
    theme: { palette: { primary: { main: '' }, error: { main: '' } } }
}
dependencies.Chip.propTypes = { label: PropTypes.string }
const moduleObject = { exports: {} }
new Function('module', ...Object.keys(dependencies), compiled)(moduleObject, ...Object.values(dependencies))
const MessageStatus = moduleObject.exports
const savedMessage = {
    usedTools: [{ tool: 'query-used' }],
    calledTools: [{ tool: 'query-called' }],
    agentReasoning: [{ agentName: 'reader' }],
    agentFlowExecutedData: [{ data: 'execution' }]
}

test.each([undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'])('%s hides live and saved tool cards when disabled', (type) => {
    for (const message of [savedMessage, JSON.parse(JSON.stringify(savedMessage))]) {
        expect(
            renderToStaticMarkup(
                <MessageStatus message={message} showToolEvents={resolveShowToolEvents({ showToolEvents: { status: false } }, type)} />
            )
        ).toBe('')
    }
})

test('a chatflow calling a Harness keeps its run card', () => {
    const html = renderToStaticMarkup(<MessageStatus message={{ ...savedMessage, harnessTrace: {} }} showToolEvents={false} />)
    expect(html).toContain('Harness run card')
    expect(html).not.toMatch(/query-used|query-called|Agent reasoning|Agent execution/)
})

test.each([undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'])('%s renders cards with the setting on', (type) => {
    const html = renderToStaticMarkup(
        <MessageStatus message={savedMessage} showToolEvents={resolveShowToolEvents({ showToolEvents: { status: true } }, type)} />
    )
    for (const label of ['query-used', 'query-called', 'Agent reasoning card', 'Agent execution card']) expect(html).toContain(label)
})

test.each([undefined, 'CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS'])('%s applies its type default to message cards', (type) => {
    const showToolEvents = resolveShowToolEvents(undefined, type)
    const html = renderToStaticMarkup(<MessageStatus message={savedMessage} showToolEvents={showToolEvents} />)
    expect(html.includes('query-used')).toBe(['AGENTFLOW', 'MULTIAGENT', 'HARNESS'].includes(type))
})

test('answer tokens create a reply even when no tool or step-status event opened it', () => {
    const start = source.indexOf('    const updateLastMessage =')
    const stop = source.indexOf('    const updateErrorMessage =', start)
    let messages = [{ message: 'Question', type: 'userMessage' }]
    const update = new Function('setMessages', 'cloneDeep', source.slice(start, stop) + '\nreturn updateLastMessage')(
        (fn) => {
            messages = fn(messages)
        },
        (value) => JSON.parse(JSON.stringify(value))
    )
    update('First ')
    update('answer')
    expect(messages).toEqual([
        { message: 'Question', type: 'userMessage' },
        { message: 'First answer', type: 'apiMessage', feedback: null }
    ])
})
