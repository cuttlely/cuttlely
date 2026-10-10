import { useState } from 'react'
import PropTypes from 'prop-types'

import { Tabs, Tab, Box } from '@mui/material'
import { CopyBlock, atomOneDark } from 'react-code-blocks'

// Project import
import { CheckboxInput } from '@/ui-component/checkbox/Checkbox'

// Const
import { baseURL } from '@/store/constant'

// The snippets load Cuttlely's own chat widget (packages/chat-widget) from this server at /embed/chat.js.
// The script is versioned with the server, so an embed always matches the server it talks to.

function TabPanel(props) {
    const { children, value, index, ...other } = props
    return (
        <div
            role='tabpanel'
            hidden={value !== index}
            id={`attachment-tabpanel-${index}`}
            aria-labelledby={`attachment-tab-${index}`}
            {...other}
        >
            {value === index && <Box sx={{ p: 1 }}>{children}</Box>}
        </div>
    )
}

TabPanel.propTypes = {
    children: PropTypes.node,
    index: PropTypes.number.isRequired,
    value: PropTypes.number.isRequired
}

function a11yProps(index) {
    return {
        id: `attachment-tab-${index}`,
        'aria-controls': `attachment-tabpanel-${index}`
    }
}

const scriptUrl = () => `${baseURL}/embed/chat.js`

const embedPopupHtmlCode = (chatflowid) => `<script src="${scriptUrl()}" data-flow-id="${chatflowid}" defer></script>`

const embedFullpageHtmlCode = (chatflowid) => `<div id="cuttlely-chat" style="height: 100vh"></div>
<script src="${scriptUrl()}" data-flow-id="${chatflowid}" data-mode="page" data-target="#cuttlely-chat" defer></script>`

const reactLoader = () => `function loadCuttlelyChat() {
    if (window.cuttlelyChat) return Promise.resolve(window.cuttlelyChat)
    return new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '${scriptUrl()}'
        script.onload = () => resolve(window.cuttlelyChat)
        script.onerror = reject
        document.head.append(script)
    })
}`

const reactComponent = (chatflowid, name, mode, style, extra = '') => `import { useEffect, useRef } from 'react'

${reactLoader()}

export const ${name} = () => {
    const ref = useRef(null)
    useEffect(() => {
        let widget
        let cancelled = false
        loadCuttlelyChat().then((chat) => {
            if (!cancelled && ref.current) {
                widget = chat.mount(ref.current, {
                    flowId: '${chatflowid}',
                    mode: '${mode}'${extra}
                })
            }
        })
        return () => {
            cancelled = true
            widget?.destroy()
        }
    }, [])
    return <div ref={ref}${style} />
}`

const embedPopupReactCode = (chatflowid) => reactComponent(chatflowid, 'CuttlelyChatBubble', 'bubble', '')

const embedFullpageReactCode = (chatflowid) => reactComponent(chatflowid, 'CuttlelyChatPage', 'page', " style={{ height: '100vh' }}")

const optionsBlock = (indent) =>
    `
theme: 'auto', // 'light' or 'dark'
open: false, // bubble only: start with the chat open
config: {
    // Leave anything out to use what the flow's Share settings saved.
    title: 'Bakery helper',
    welcome: 'Hi! Ask me about today\\'s bakes.',
    placeholder: 'Ask a question',
    starterPrompts: ['What is fresh today?', 'Do you have gluten-free bread?'],
    colors: { accent: '#6a3df2', headerBg: '#6a3df2', headerText: '#ffffff' }
},
overrideConfig: {
    // Flow settings to override per request, if the flow allows overrides.
}`
        .split('\n')
        .map((line) => (line ? ' '.repeat(indent) + line : line))
        .join('\n')

const embedHtmlCodeCustomization = (chatflowid, mode) => `<div id="cuttlely-chat"${mode === 'page' ? ' style="height: 100vh"' : ''}></div>
<script src="${scriptUrl()}" defer></script>
<script>
    window.addEventListener('DOMContentLoaded', () => {
        window.cuttlelyChat.mount(document.getElementById('cuttlely-chat'), {
            flowId: '${chatflowid}',
            mode: '${mode}',${optionsBlock(12)}
        })
    })
</script>`

const embedReactCodeCustomization = (chatflowid, mode) =>
    reactComponent(
        chatflowid,
        mode === 'page' ? 'CuttlelyChatPage' : 'CuttlelyChatBubble',
        mode,
        mode === 'page' ? " style={{ height: '100vh' }}" : '',
        `,${optionsBlock(20)}`
    )

const EmbedChat = ({ chatflowid }) => {
    const codes = ['Popup Html', 'Fullpage Html', 'Popup React', 'Fullpage React']
    const [value, setValue] = useState(0)
    const [embedChatCheckboxVal, setEmbedChatCheckbox] = useState(false)

    const onCheckBoxEmbedChatChanged = (newVal) => {
        setEmbedChatCheckbox(newVal)
    }

    const handleChange = (event, newValue) => {
        setValue(newValue)
    }

    const getCode = (codeLang) => {
        switch (codeLang) {
            case 'Popup Html':
                return embedPopupHtmlCode(chatflowid)
            case 'Fullpage Html':
                return embedFullpageHtmlCode(chatflowid)
            case 'Popup React':
                return embedPopupReactCode(chatflowid)
            case 'Fullpage React':
                return embedFullpageReactCode(chatflowid)
            default:
                return ''
        }
    }

    const getCodeCustomization = (codeLang) => {
        switch (codeLang) {
            case 'Fullpage Html':
                return embedHtmlCodeCustomization(chatflowid, 'page')
            case 'Popup React':
                return embedReactCodeCustomization(chatflowid, 'bubble')
            case 'Fullpage React':
                return embedReactCodeCustomization(chatflowid, 'page')
            default:
                return embedHtmlCodeCustomization(chatflowid, 'bubble')
        }
    }

    return (
        <>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                <div style={{ flex: 80 }}>
                    <Tabs value={value} onChange={handleChange} aria-label='tabs'>
                        {codes.map((codeLang, index) => (
                            <Tab key={index} label={codeLang} {...a11yProps(index)}></Tab>
                        ))}
                    </Tabs>
                </div>
            </div>
            <div style={{ marginTop: 10 }}></div>
            {codes.map((codeLang, index) => (
                <TabPanel key={index} value={value} index={index}>
                    <span>
                        {value === 0 || value === 1 ? (
                            <>
                                Paste this anywhere in the <code>{`<body>`}</code> tag of your html file.
                            </>
                        ) : (
                            <>Add this component to your React app.</>
                        )}
                        <p>
                            The chat script comes from this Cuttlely server (<code>{scriptUrl()}</code>) and always matches its version.
                            Colors, title, welcome message and starter prompts come from this flow&apos;s Share settings. A site on another
                            domain must be listed in the flow&apos;s Allowed Domains (Configuration) if that list is set.
                        </p>
                    </span>
                    <div style={{ height: 10 }}></div>
                    <CopyBlock theme={atomOneDark} text={getCode(codeLang)} language='javascript' showLineNumbers={false} wrapLines />

                    <CheckboxInput label='Show Embed Chat Config' value={embedChatCheckboxVal} onChange={onCheckBoxEmbedChatChanged} />

                    {embedChatCheckboxVal && (
                        <CopyBlock
                            theme={atomOneDark}
                            text={getCodeCustomization(codeLang)}
                            language='javascript'
                            showLineNumbers={false}
                            wrapLines
                        />
                    )}
                </TabPanel>
            ))}
        </>
    )
}

EmbedChat.propTypes = {
    chatflowid: PropTypes.string
}

export default EmbedChat
