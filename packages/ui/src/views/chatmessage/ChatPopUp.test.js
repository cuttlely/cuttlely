/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
// The popup's ChatMessage holds its messages in local state. Start a new session must
// clear them on screen, forget the saved chatId and keep the stored messages.
// The stub, like ChatMessage, loads messages on mount only for a saved chatId.
jest.mock('./ChatMessage', () => {
    const { createElement, useState } = require('react')
    const { v4: uuidv4 } = require('uuid')
    return function ChatMessageStub() {
        const [messages] = useState(() => {
            const saved = JSON.parse(globalThis.localStorage.getItem('ZZ-TEST-flow_INTERNAL') || '{}')
            return saved.chatId ? ['ZZ-TEST-message'] : []
        })
        const [chatId] = useState(() => uuidv4())
        return createElement(
            'div',
            { 'data-chat-id': chatId },
            messages.map((m) => createElement('div', { key: m, 'data-testid': 'zz-msg' }, m))
        )
    }
})
// The expanded dialog renders the same ChatMessage, so a reset must give it a new session too.
jest.mock('./ChatExpandDialog', () => {
    const { createElement } = require('react')
    const ChatMessage = require('./ChatMessage')
    const PropTypes = require('prop-types')
    function ChatExpandDialogStub(props) {
        if (!props.show) return null
        return createElement(
            'div',
            { 'data-testid': 'zz-expanded' },
            createElement('button', { 'aria-label': 'expanded-clear', onClick: props.onClear }),
            createElement(ChatMessage)
        )
    }
    ChatExpandDialogStub.propTypes = { show: PropTypes.bool, onClear: PropTypes.func }
    return ChatExpandDialogStub
})
jest.mock('@/api/chatmessage', () => ({
    __esModule: true,
    default: { deleteChatmessage: jest.fn(() => Promise.resolve({})) }
}))
jest.mock('@/hooks/useConfirm', () => () => ({ confirm: () => Promise.resolve(true) }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('react-redux', () => ({
    useDispatch: () => () => {},
    useSelector: () => ({})
}))
jest.mock('@/store/context/ReactFlowContext', () => {
    const { createContext } = require('react')
    return { flowContext: createContext({ clearAgentflowNodeStatus: () => {} }) }
})

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import chatmessageApi from '@/api/chatmessage'
import ChatPopUp from './ChatPopUp'

const FLOW = 'ZZ-TEST-flow'

test('Start a new session clears the popup chat, drops the saved chatId and deletes nothing', async () => {
    jest.useFakeTimers()
    localStorage.setItem(`${FLOW}_INTERNAL`, JSON.stringify({ chatId: 'ZZ-TEST-chat' }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(ChatPopUp, { chatflowid: FLOW })))
    })
    await act(async () => {
        container.querySelector('[aria-label="chat"]').click()
    })
    expect(container.querySelectorAll('[data-testid="zz-msg"]')).toHaveLength(1)
    const firstChatId = container.querySelector('[data-chat-id]').getAttribute('data-chat-id')

    await act(async () => {
        container.querySelector('[aria-label="clear"]').click()
    })
    await act(async () => {
        jest.runAllTimers()
    })

    expect(container.querySelectorAll('[data-testid="zz-msg"]')).toHaveLength(0)
    expect(container.querySelector('[data-chat-id]').getAttribute('data-chat-id')).not.toBe(firstChatId)
    expect(JSON.parse(globalThis.localStorage.getItem(`${FLOW}_INTERNAL`) || '{}').chatId).toBeUndefined()
    expect(chatmessageApi.deleteChatmessage).not.toHaveBeenCalled()

    // The expanded dialog starts a new session as well.
    globalThis.localStorage.setItem(`${FLOW}_INTERNAL`, JSON.stringify({ chatId: 'ZZ-TEST-chat-2' }))
    await act(async () => {
        container.querySelector('[aria-label="expand"]').click()
    })
    const expanded = () => container.querySelector('[data-testid="zz-expanded"] [data-chat-id]')
    const expandedChatId = expanded().getAttribute('data-chat-id')
    expect(container.querySelectorAll('[data-testid="zz-expanded"] [data-testid="zz-msg"]')).toHaveLength(1)
    await act(async () => {
        container.querySelector('[aria-label="expanded-clear"]').click()
    })
    await act(async () => {
        jest.runAllTimers()
    })
    expect(expanded().getAttribute('data-chat-id')).not.toBe(expandedChatId)
    expect(container.querySelectorAll('[data-testid="zz-expanded"] [data-testid="zz-msg"]')).toHaveLength(0)
    expect(chatmessageApi.deleteChatmessage).not.toHaveBeenCalled()

    act(() => root.unmount())
    jest.useRealTimers()
})
