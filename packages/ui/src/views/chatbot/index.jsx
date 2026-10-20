import { useEffect, useRef, useState } from 'react'
import { mount } from '@cuttlely/chat'

// API
import chatflowsApi from '@/api/chatflows'

//Const
import { baseURL } from '@/store/constant'

// ==============================|| Chatbot ||============================== //

// The shared chat link (/chatbot/:id). The chat itself is Cuttlely's own widget (packages/chat-widget).
// This page only decides whether the visitor may open it: the flow must be public (or the visitor signed in to its
// workspace) and must not need an API key. Otherwise the widget shows its private or not-found state.
const blockedFor = (error, chatflow) => {
    if (error) return error?.response?.status === 404 ? 'missing' : 'private'
    if (!chatflow) return 'missing'
    if (chatflow.hasApiKey || chatflow.apikeyid) return 'private'
    return null
}

const overrideConfigOf = (chatflow) => {
    try {
        const parsed = chatflow?.chatbotConfig ? JSON.parse(chatflow.chatbotConfig) : {}
        return parsed?.overrideConfig && typeof parsed.overrideConfig === 'object' ? parsed.overrideConfig : undefined
    } catch {
        return undefined
    }
}

const ChatbotFull = () => {
    const URLpath = document.location.pathname.toString().split('/')
    const chatflowId = URLpath[URLpath.length - 1] === 'chatbot' ? '' : URLpath[URLpath.length - 1]
    const hostRef = useRef(null)
    const [access, setAccess] = useState(null)

    useEffect(() => {
        let cancelled = false
        chatflowsApi
            .getSpecificChatflowFromPublicEndpoint(chatflowId)
            .then((response) => {
                if (!cancelled) setAccess({ chatflow: response?.data, blocked: blockedFor(null, response?.data) })
            })
            .catch((error) => {
                if (!cancelled) setAccess({ chatflow: null, blocked: blockedFor(error, null) })
            })
        return () => {
            cancelled = true
        }
    }, [chatflowId])

    useEffect(() => {
        if (!access || !hostRef.current || !chatflowId) return undefined
        if (access.chatflow?.name) document.title = access.chatflow.name
        const widget = mount(hostRef.current, {
            flowId: chatflowId,
            apiHost: baseURL,
            mode: 'page',
            theme: 'auto',
            blocked: access.blocked || undefined,
            overrideConfig: overrideConfigOf(access.chatflow)
        })
        return () => widget.destroy()
    }, [access, chatflowId])

    return <div ref={hostRef} style={{ height: '100vh', width: '100%' }} />
}

export default ChatbotFull
