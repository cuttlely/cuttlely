import { endpointAccessSelection, endpointAccessUpdate } from '../apikey/endpointAccess'
import APIKeyDialog from '../apikey/APIKeyDialog'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useMemo } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import PropTypes from 'prop-types'

import {
    Tabs,
    Tab,
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    Box,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Typography,
    Stack,
    Card,
    Alert,
    Snackbar,
    TextField
} from '@mui/material'
import { CopyBlock, atomOneDark } from 'react-code-blocks'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useTheme } from '@mui/material/styles'

// Project import
import ShareChatbot from './ShareChatbot'
import EmbedChat from './EmbedChat'
import { Available } from '@/ui-component/rbac/available'

// Const
import { baseURL } from '@/store/constant'
import { SET_CHATFLOW } from '@/store/actions'

// Images
import pythonSVG from '@/assets/images/python.svg'
import javascriptSVG from '@/assets/images/javascript.svg'
import cURLSVG from '@/assets/images/cURL.svg'
import EmbedSVG from '@/assets/images/embed.svg'
import ShareChatbotSVG from '@/assets/images/sharing.png'
import settingsSVG from '@/assets/images/settings.svg'
import { IconBulb, IconBox, IconVariable, IconExclamationCircle } from '@tabler/icons-react'

// API
import apiKeyApi from '@/api/apikey'
import chatflowsApi from '@/api/chatflows'
import configApi from '@/api/config'
import variablesApi from '@/api/variables'

// Hooks
import useApi from '@/hooks/useApi'
import { CheckboxInput } from '@/ui-component/checkbox/Checkbox'
import { TableViewOnly } from '@/ui-component/table/Table'

// Helpers
import { unshiftFiles, getConfigExamplesForJS, getConfigExamplesForPython, getConfigExamplesForCurl } from '@/utils/genericHelper'

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

const APICodeDialog = ({ show, dialogProps, onCancel }) => {
    const portalElement = document.getElementById('portal')
    const navigate = useNavigate()
    const dispatch = useDispatch()
    const theme = useTheme()
    const chatflow = useSelector((state) => state.canvas.chatflow)
    const isCustomAssistant = chatflow?.type === 'ASSISTANT'
    const apiConfig = chatflow?.apiConfig ? JSON.parse(chatflow.apiConfig) : {}
    const overrideConfigStatus = apiConfig?.overrideConfig?.status !== undefined ? apiConfig.overrideConfig.status : false

    const startNodeInputs = useMemo(() => {
        if (!chatflow?.flowData) return null
        try {
            const parsed = JSON.parse(chatflow.flowData)
            const startNode = (parsed.nodes || []).find((n) => n?.data?.name === 'startAgentflow')
            return startNode?.data?.inputs ?? null
        } catch {
            return null
        }
    }, [chatflow?.flowData])

    const startInputType = startNodeInputs?.startInputType
    const isWebhookFlow = startInputType === 'webhookTrigger'
    const isScheduleFlow = startInputType === 'scheduleInput'
    const webhookMethod = (startNodeInputs?.webhookMethod || 'POST').toUpperCase()
    const webhookContentType = startNodeInputs?.webhookContentType || 'application/json'
    const webhookEnableAuth = startNodeInputs?.webhookEnableAuth === true
    const webhookSignatureHeader = startNodeInputs?.webhookSignatureHeader || 'x-webhook-signature'
    const webhookResponseMode = startNodeInputs?.webhookResponseMode || 'sync'

    const codes = useMemo(() => {
        if (isWebhookFlow || isScheduleFlow) return ['Python', 'JavaScript', 'cURL']
        return ['Embed', 'Python', 'JavaScript', 'cURL', 'Share Chatbot']
    }, [isWebhookFlow, isScheduleFlow])
    const [value, setValue] = useState(0)
    const [apiKeys, setAPIKeys] = useState([])
    const [rollout, setRollout] = useState(null)
    const [chatflowApiKeyId, setChatflowApiKeyId] = useState('')
    const [selectedApiKey, setSelectedApiKey] = useState({})
    const [savedAccess, setSavedAccess] = useState(null)
    const [accessMessage, setAccessMessage] = useState('')
    const [accessError, setAccessError] = useState('')
    const [createKeyOpen, setCreateKeyOpen] = useState(false)
    const savedMode = savedAccess?.apiAccessMode
    const savedLegacyId = savedAccess?.apikeyid
    const accessKnown = savedAccess && (['public', 'private'].includes(savedMode) || savedLegacyId !== undefined)
    const createKeyProps = useMemo(
        () => ({
            type: 'ADD',
            title: 'Create key for this flow',
            confirmButtonName: 'Create key',
            flowId: dialogProps.chatflowid
        }),
        [dialogProps.chatflowid]
    )
    const exampleApiKey = selectedApiKey?.apiKey || '<your-api-key>'
    const [checkboxVal, setCheckbox] = useState(false)
    const [nodeConfig, setNodeConfig] = useState({})
    const [nodeConfigExpanded, setNodeConfigExpanded] = useState({})
    const [nodeOverrides, setNodeOverrides] = useState(apiConfig?.overrideConfig?.nodes ?? null)
    const [variableOverrides, setVariableOverrides] = useState(apiConfig?.overrideConfig?.variables ?? [])

    const getAllAPIKeysApi = useApi(apiKeyApi.getAllAPIKeys)
    const updateChatflowApi = useApi(chatflowsApi.updateChatflow)
    const getIsChatflowStreamingApi = useApi(chatflowsApi.getIsChatflowStreaming)
    const getConfigApi = useApi(configApi.getConfig)
    const getAllVariablesApi = useApi(variablesApi.getAllVariables)

    // Off/shadow preserve the legacy binding workflow; enforced access uses many principal grants.
    const keyOptions = useMemo(
        () =>
            rollout === 'on'
                ? [
                      { label: 'Public: anyone with the link', name: '' },
                      {
                          label: isCustomAssistant ? 'Private (custom assistant grants unsupported)' : 'Private: only keys you pick',
                          name: 'accesskeys'
                      }
                  ]
                : [
                      { label: 'Public: anyone with the link', name: '' },
                      ...(savedMode === 'private' && !savedLegacyId
                          ? [{ label: 'Private (scoped access keys unavailable)', name: 'accesskeys' }]
                          : []),
                      ...(isCustomAssistant && savedLegacyId
                          ? [{ label: 'Private (existing legacy binding; changes unavailable)', name: savedLegacyId }]
                          : []),
                      ...apiKeys
                          .filter(
                              (key) =>
                                  !isCustomAssistant &&
                                  key.accessPolicy?.legacy &&
                                  !key.disabledAt &&
                                  (!key.legacyRevokedAt || new Date(key.legacyRevokedAt) > new Date())
                          )
                          .map((key) => ({ label: key.keyName, name: key.id }))
                  ],
        [rollout, apiKeys, savedMode, savedLegacyId, isCustomAssistant]
    )

    const onCheckBoxChanged = (newVal) => {
        setCheckbox(newVal)
        if (newVal) {
            getConfigApi.request(dialogProps.chatflowid)
            getAllVariablesApi.request()
        }
    }

    const onApiKeySelected = (keyValue) => {
        if (isCustomAssistant && ['off', 'shadow'].includes(rollout) && keyValue) return
        if (keyValue === 'addnewkey') {
            navigate('/apikey')
            return
        }
        const updateBody = endpointAccessUpdate(rollout, keyValue)
        if (!updateBody) return
        setAccessMessage('')
        setAccessError('')
        setChatflowApiKeyId(keyValue)
        const selectedKey = apiKeys.find((key) => key.id === keyValue)
        setSelectedApiKey(selectedKey || {})
        updateChatflowApi.request(dialogProps.chatflowid, updateBody)
    }

    const groupByNodeLabel = (nodes) => {
        const result = {}
        const newNodeOverrides = {}
        const seenNodes = new Set()

        nodes.forEach((item) => {
            const { node, nodeId, label, name, type } = item
            seenNodes.add(node)

            if (!result[node]) {
                result[node] = {
                    nodeIds: [],
                    params: []
                }
            }

            if (!newNodeOverrides[node]) {
                // If overrideConfigStatus is true, copy existing config for this node
                newNodeOverrides[node] = overrideConfigStatus ? [...(nodeOverrides[node] || [])] : []
            }

            if (!result[node].nodeIds.includes(nodeId)) result[node].nodeIds.push(nodeId)

            const param = { label, name, type }

            if (!result[node].params.some((existingParam) => JSON.stringify(existingParam) === JSON.stringify(param))) {
                result[node].params.push(param)
                const paramExists = newNodeOverrides[node].some(
                    (existingParam) => existingParam.label === label && existingParam.name === name && existingParam.type === type
                )
                if (!paramExists) {
                    newNodeOverrides[node].push({ ...param, enabled: false })
                }
            }
        })

        // Sort the nodeIds array
        for (const node in result) {
            result[node].nodeIds.sort()
        }
        setNodeConfig(result)
        setNodeOverrides(newNodeOverrides)
    }

    const groupByVariableLabel = (variables) => {
        const newVariables = []
        const seenVariables = new Set()

        variables.forEach((item) => {
            const { id, name, type } = item
            seenVariables.add(id)

            const param = { id, name, type }

            // If overrideConfigStatus is true, look for existing variable config
            // Otherwise, create new default config
            if (overrideConfigStatus) {
                const existingVariable = variableOverrides?.find((existingParam) => existingParam.id === id)
                if (existingVariable) {
                    if (!newVariables.some((variable) => variable.id === id)) {
                        newVariables.push({ ...existingVariable })
                    }
                } else {
                    if (!newVariables.some((variable) => variable.id === id)) {
                        newVariables.push({ ...param, enabled: false })
                    }
                }
            } else {
                // When no override config exists, create default values
                if (!newVariables.some((variable) => variable.id === id)) {
                    newVariables.push({ ...param, enabled: false })
                }
            }
        })

        // If overrideConfigStatus is true, clean up any variables that no longer exist
        if (overrideConfigStatus && variableOverrides) {
            variableOverrides.forEach((existingVariable) => {
                if (!seenVariables.has(existingVariable.id)) {
                    const index = newVariables.findIndex((newVariable) => newVariable.id === existingVariable.id)
                    if (index !== -1) {
                        newVariables.splice(index, 1)
                    }
                }
            })
        }

        setVariableOverrides(newVariables)
    }

    const handleAccordionChange = (nodeLabel) => (event, isExpanded) => {
        const accordianNodes = { ...nodeConfigExpanded }
        accordianNodes[nodeLabel] = isExpanded
        setNodeConfigExpanded(accordianNodes)
    }

    useEffect(() => {
        if (updateChatflowApi.data) {
            dispatch({ type: SET_CHATFLOW, chatflow: updateChatflowApi.data })
            setSavedAccess(updateChatflowApi.data)
            setAccessMessage('API access saved.')
        }
    }, [updateChatflowApi.data, dispatch])

    useEffect(() => {
        if (updateChatflowApi.error) {
            setAccessError(updateChatflowApi.error.response?.data?.message || 'API access could not be saved. Reload and try again.')
            setChatflowApiKeyId(endpointAccessSelection(rollout, savedMode, savedLegacyId))
        }
    }, [updateChatflowApi.error, rollout, savedMode, savedLegacyId])

    useEffect(() => {
        if (getConfigApi.data) {
            groupByNodeLabel(getConfigApi.data)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getConfigApi.data])

    useEffect(() => {
        if (getAllVariablesApi.data) {
            groupByVariableLabel(getAllVariablesApi.data)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllVariablesApi.data])

    const handleChange = (event, newValue) => {
        setValue(newValue)
    }

    const getWebhookCode = (codeLang, apiKey) => {
        const url = `${baseURL}/api/v1/webhook/${dialogProps.chatflowid}`
        const sendsBody = webhookMethod !== 'GET' && webhookMethod !== 'DELETE'
        const isJson = webhookContentType === 'application/json'
        const sampleBodyJs = isJson ? '{ example: "value" }' : '"example=value"'
        const sampleBodyPy = isJson ? '{"example": "value"}' : '"example=value"'
        const sampleBodyCurl = isJson ? '{"example": "value"}' : 'example=value'

        if (codeLang === 'Python') {
            const headers = [`"Content-Type": "${webhookContentType}"`]
            if (apiKey) headers.push(`"Authorization": "Bearer ${apiKey}"`)
            if (webhookEnableAuth) headers.push(`"${webhookSignatureHeader}": "<signature>"`)
            const bodyArg = sendsBody ? (isJson ? `, json=${sampleBodyPy}` : `, data=${sampleBodyPy}`) : ''
            return `import requests

API_URL = "${url}"
headers = {${headers.join(', ')}}

response = requests.${webhookMethod.toLowerCase()}(API_URL, headers=headers${bodyArg})
print(response.json())
`
        } else if (codeLang === 'JavaScript') {
            const headers = [`"Content-Type": "${webhookContentType}"`]
            if (apiKey) headers.push(`Authorization: "Bearer " + process.env.CUTTLELY_API_KEY`)
            if (webhookEnableAuth) headers.push(`"${webhookSignatureHeader}": "<signature>"`)
            const bodyLine = sendsBody ? `,\n        body: ${isJson ? `JSON.stringify(${sampleBodyJs})` : sampleBodyJs}` : ''
            return `const response = await fetch(
    "${url}",
    {
        method: "${webhookMethod}",
        headers: { ${headers.join(', ')} }${bodyLine}
    }
);
const result = await response.json();
console.log(result);
`
        } else if (codeLang === 'cURL') {
            const parts = [`curl ${url}`, `-X ${webhookMethod}`, `-H "Content-Type: ${webhookContentType}"`]
            if (apiKey) parts.push(`-H "Authorization: Bearer ${apiKey}"`)
            if (webhookEnableAuth) parts.push(`-H "${webhookSignatureHeader}: <signature>"`)
            if (sendsBody) parts.push(`-d '${sampleBodyCurl}'`)
            return parts.join(' \\\n     ')
        }
        return ''
    }

    const getCode = (codeLang) => {
        if (isWebhookFlow) return getWebhookCode(codeLang, null)
        if (codeLang === 'Python') {
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"

def query(payload):
    response = requests.post(API_URL, json=payload)
    return response.json()

output = query({
    "question": "Hey, how are you?",
})
`
        } else if (codeLang === 'JavaScript') {
            return `// Node.js server only. Keep CUTTLELY_API_KEY in your server environment.
async function query(data) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        }
    );
    const result = await response.json();
    return result;
}

query({"question": "Hey, how are you?"}).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\
     -d '{"question": "Hey, how are you?"}' \\
     -H "Content-Type: application/json"`
        }
        return ''
    }

    const getCodeWithAuthorization = (codeLang) => {
        if (isWebhookFlow) return getWebhookCode(codeLang, exampleApiKey)
        if (codeLang === 'Python') {
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"
headers = {"Authorization": "Bearer ${exampleApiKey}"}

def query(payload):
    response = requests.post(API_URL, headers=headers, json=payload)
    return response.json()
    
output = query({
    "question": "Hey, how are you?",
})
`
        } else if (codeLang === 'JavaScript') {
            return `// Node.js server only. Keep CUTTLELY_API_KEY in your server environment.
async function query(data) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            headers: {
                Authorization: "Bearer " + process.env.CUTTLELY_API_KEY,
                "Content-Type": "application/json"
            },
            method: "POST",
            body: JSON.stringify(data)
        }
    );
    const result = await response.json();
    return result;
}

query({"question": "Hey, how are you?"}).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\
     -d '{"question": "Hey, how are you?"}' \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer ${exampleApiKey}"`
        }
        return ''
    }

    const getLang = (codeLang) => {
        if (codeLang === 'Python') {
            return 'python'
        } else if (codeLang === 'JavaScript') {
            return 'javascript'
        } else if (codeLang === 'cURL') {
            return 'bash'
        }
        return 'python'
    }

    const getSVG = (codeLang) => {
        if (codeLang === 'Python') {
            return pythonSVG
        } else if (codeLang === 'JavaScript') {
            return javascriptSVG
        } else if (codeLang === 'Embed') {
            return EmbedSVG
        } else if (codeLang === 'cURL') {
            return cURLSVG
        } else if (codeLang === 'Share Chatbot') {
            return ShareChatbotSVG
        } else if (codeLang === 'Configuration') {
            return settingsSVG
        }
        return pythonSVG
    }

    // ----------------------------CONFIG FORM DATA --------------------------//

    const getConfigCodeWithFormData = (codeLang, configData) => {
        if (codeLang === 'Python') {
            configData = unshiftFiles(configData)
            let fileType = configData[0].type
            if (fileType.includes(',')) fileType = fileType.split(',')[0]
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"

# use form data to upload files
form_data = {
    "files": ${`('example${fileType}', open('example${fileType}', 'rb'))`}
}
body_data = {${getConfigExamplesForPython(configData, 'formData')}}

def query(form_data):
    response = requests.post(API_URL, files=form_data, data=body_data)
    return response.json()

output = query(form_data)
`
        } else if (codeLang === 'JavaScript') {
            return `// use FormData to upload files
let formData = new FormData();
${getConfigExamplesForJS(configData, 'formData')}
async function query(formData) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            method: "POST",
            body: formData
        }
    );
    const result = await response.json();
    return result;
}

query(formData).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\${getConfigExamplesForCurl(configData, 'formData')} \\
     -H "Content-Type: multipart/form-data"`
        }
        return ''
    }

    // ----------------------------CONFIG FORM DATA with AUTH--------------------------//

    const getConfigCodeWithFormDataWithAuth = (codeLang, configData) => {
        if (codeLang === 'Python') {
            configData = unshiftFiles(configData)
            let fileType = configData[0].type
            if (fileType.includes(',')) fileType = fileType.split(',')[0]
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"
headers = {"Authorization": "Bearer ${exampleApiKey}"}

# use form data to upload files
form_data = {
    "files": ${`('example${fileType}', open('example${fileType}', 'rb'))`}
}
body_data = {${getConfigExamplesForPython(configData, 'formData')}}

def query(form_data):
    response = requests.post(API_URL, headers=headers, files=form_data, data=body_data)
    return response.json()

output = query(form_data)
`
        } else if (codeLang === 'JavaScript') {
            return `// use FormData to upload files
let formData = new FormData();
${getConfigExamplesForJS(configData, 'formData')}
async function query(formData) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            headers: { Authorization: "Bearer " + process.env.CUTTLELY_API_KEY },
            method: "POST",
            body: formData
        }
    );
    const result = await response.json();
    return result;
}

query(formData).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\${getConfigExamplesForCurl(configData, 'formData')} \\
     -H "Content-Type: multipart/form-data" \\
     -H "Authorization: Bearer ${exampleApiKey}"`
        }
        return ''
    }

    // ----------------------------CONFIG JSON--------------------------//

    const getConfigCode = (codeLang, configData) => {
        if (codeLang === 'Python') {
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"

def query(payload):
    response = requests.post(API_URL, json=payload)
    return response.json()

output = query({
    "question": "Hey, how are you?",
    "overrideConfig": {${getConfigExamplesForPython(configData, 'json')}
    }
})
`
        } else if (codeLang === 'JavaScript') {
            return `// Node.js server only. Keep CUTTLELY_API_KEY in your server environment.
async function query(data) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        }
    );
    const result = await response.json();
    return result;
}

query({
  "question": "Hey, how are you?",
  "overrideConfig": {${getConfigExamplesForJS(configData, 'json')}
  }
}).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\
     -d '{"question": "Hey, how are you?", "overrideConfig": {${getConfigExamplesForCurl(configData, 'json')}}' \\
     -H "Content-Type: application/json"`
        }
        return ''
    }

    // ----------------------------CONFIG JSON with AUTH--------------------------//

    const getConfigCodeWithAuthorization = (codeLang, configData) => {
        if (codeLang === 'Python') {
            return `import requests

API_URL = "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}"
headers = {"Authorization": "Bearer ${exampleApiKey}"}

def query(payload):
    response = requests.post(API_URL, headers=headers, json=payload)
    return response.json()

output = query({
    "question": "Hey, how are you?",
    "overrideConfig": {${getConfigExamplesForPython(configData, 'json')}
    }
})
`
        } else if (codeLang === 'JavaScript') {
            return `// Node.js server only. Keep CUTTLELY_API_KEY in your server environment.
async function query(data) {
    const response = await fetch(
        "${baseURL}/api/v1/prediction/${dialogProps.chatflowid}",
        {
            headers: {
                Authorization: "Bearer " + process.env.CUTTLELY_API_KEY,
                "Content-Type": "application/json"
            },
            method: "POST",
            body: JSON.stringify(data)
        }
    );
    const result = await response.json();
    return result;
}

query({
  "question": "Hey, how are you?",
  "overrideConfig": {${getConfigExamplesForJS(configData, 'json')}
  }
}).then((response) => {
    console.log(response);
});
`
        } else if (codeLang === 'cURL') {
            return `curl ${baseURL}/api/v1/prediction/${dialogProps.chatflowid} \\
     -X POST \\
     -d '{"question": "Hey, how are you?", "overrideConfig": {${getConfigExamplesForCurl(configData, 'json')}}' \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer ${exampleApiKey}"`
        }
        return ''
    }

    const getMultiConfigCodeWithFormData = (codeLang) => {
        if (dialogProps.isAgentflowV2) {
            if (codeLang === 'Python') {
                return `# Specify multiple values for a config parameter by specifying the node id
body_data = {
    "agentModelConfig": {
        "agentAgentflow_0": {
            "temperature": "0.3"
        },
        "agentAgentflow_1": {
            "temperature": "0.7"
        }
    }
}`
            } else if (codeLang === 'JavaScript') {
                return `// Specify multiple values for a config parameter by specifying the node id
formData.append("agentModelConfig[agentAgentflow_0][temperature]", "0.3")
formData.append("agentModelConfig[agentAgentflow_1][temperature]", "0.7")`
            } else if (codeLang === 'cURL') {
                return `-F "agentModelConfig[agentAgentflow_0][temperature]=0.3" \\
-F "agentModelConfig[agentAgentflow_1][temperature]=0.7" \\`
            }
        } else {
            if (codeLang === 'Python') {
                return `# Specify multiple values for a config parameter by specifying the node id
body_data = {
    "temperature": {
        "chatOpenAI_0": "0.3",
        "openAIEmbeddings_0": "0.7"
    }
}`
            } else if (codeLang === 'JavaScript') {
                return `// Specify multiple values for a config parameter by specifying the node id
formData.append("temperature[chatOpenAI_0]", "0.3")
formData.append("temperature[openAIEmbeddings_0]", "0.7")`
            } else if (codeLang === 'cURL') {
                return `-F "temperature[chatOpenAI_0]=0.3" \\
-F "temperature[openAIEmbeddings_0]=0.7" \\`
            }
        }
    }

    const getMultiConfigCode = () => {
        if (dialogProps.isAgentflowV2) {
            return `{
    "overrideConfig": {
        "agentModelConfig": {
            "agentAgentflow_0": {
                "temperature": "0.3"
            },
            "agentAgentflow_1": {
                "temperature": "0.7"
            }
        }
    }
}`
        } else {
            return `{
    "overrideConfig": {
        "temperature": {
            "chatOpenAI_0": "0.3",
            "openAIEmbeddings_0": "0.7"
        }
    }
}`
        }
    }

    useEffect(() => {
        if (savedAccess) {
            const keys = getAllAPIKeysApi.data || []
            setAPIKeys(keys)
            if (savedMode === 'private' || (savedMode !== 'public' && savedLegacyId)) {
                setChatflowApiKeyId(endpointAccessSelection(rollout, savedMode, savedLegacyId))
                setSelectedApiKey(keys.find((key) => key.id === savedLegacyId))
            } else {
                setChatflowApiKeyId('')
                setSelectedApiKey({})
            }
        }
    }, [savedAccess, savedMode, savedLegacyId, getAllAPIKeysApi.data, rollout])

    useEffect(() => {
        let active = true
        if (show) {
            setAccessMessage('')
            setAccessError('')
            const payload = chatflow?.id === dialogProps.chatflowid ? chatflow : {}
            setSavedAccess({
                apiAccessMode: payload.apiAccessMode ?? dialogProps.apiAccessMode,
                apikeyid: payload.apikeyid ?? dialogProps.chatflowApiKeyId
            })
            if (chatflowsApi.getSpecificChatflow)
                chatflowsApi.getSpecificChatflow(dialogProps.chatflowid).then(
                    (result) => {
                        if (active) setSavedAccess(result.data)
                    },
                    () => {
                        if (active) setAccessError('Saved API access could not be refreshed. Close this dialog and try again.')
                    }
                )
            setRollout(null)
            getAllAPIKeysApi.request()
            apiKeyApi
                .options()
                .then((result) => setRollout(result.data.rollout))
                .catch(() => setRollout(null))
            getIsChatflowStreamingApi.request(dialogProps.chatflowid)
        }
        return () => {
            active = false
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [show, dialogProps.chatflowid])

    const component = show ? (
        <Dialog
            open={show}
            fullWidth
            maxWidth='md'
            onClose={onCancel}
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                {dialogProps.title}
            </DialogTitle>
            <DialogContent>
                {accessError && <Alert severity='error'>{accessError}</Alert>}
                {savedMode && <Typography>Saved API access: {savedMode === 'private' ? 'Private' : 'Public'}</Typography>}
                {isScheduleFlow ? (
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'flex-start',
                            borderRadius: 10,
                            background: 'rgb(254,252,191)',
                            padding: 12
                        }}
                    >
                        <IconExclamationCircle size={28} color='rgb(116,66,16)' style={{ flexShrink: 0 }} />
                        <span style={{ color: 'rgb(116,66,16)', marginLeft: 10, fontWeight: 500 }}>
                            This flow is configured as a <b>Scheduled Trigger</b>. It is fired automatically by the in-process scheduler on
                            its cron schedule and cannot be invoked via the prediction API. To call this flow from an API, change the Start
                            node Input Type to <b>Chat Input</b>, <b>Form Input</b>, or <b>Webhook Trigger</b>.
                        </span>
                    </div>
                ) : (
                    <>
                        {isWebhookFlow && (
                            <div
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    borderRadius: 10,
                                    background: '#d8f3dc',
                                    padding: 12,
                                    marginBottom: 16
                                }}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <IconBulb size={28} color='#2d6a4f' />
                                    <span style={{ color: '#2d6a4f', marginLeft: 10, fontWeight: 500 }}>
                                        This flow is configured as a <b>Webhook Trigger</b>. Send <b>{webhookMethod}</b> requests to{' '}
                                        <code>/api/v1/webhook/{dialogProps.chatflowid}</code> with Content-Type{' '}
                                        <code>{webhookContentType}</code>.
                                        {webhookEnableAuth && (
                                            <>
                                                {' '}
                                                Each request must include a valid signature in the <code>
                                                    {webhookSignatureHeader}
                                                </code>{' '}
                                                header.
                                            </>
                                        )}{' '}
                                        Response mode: <b>{webhookResponseMode}</b>
                                        {webhookResponseMode === 'async' && ' (returns 202 immediately, optional callback POST when done)'}
                                        {webhookResponseMode === 'stream' && ' (Server-Sent Events stream)'}.
                                    </span>
                                </div>
                            </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <div style={{ width: '100%', minWidth: 0 }}>
                                <Tabs value={value} onChange={handleChange} aria-label='tabs' variant='scrollable' scrollButtons='auto'>
                                    {codes.map((codeLang, index) => (
                                        <Tab
                                            icon={
                                                <img
                                                    style={{ objectFit: 'cover', height: 15, width: 'auto' }}
                                                    src={getSVG(codeLang)}
                                                    alt='code'
                                                />
                                            }
                                            iconPosition='start'
                                            key={index}
                                            label={codeLang === 'JavaScript' ? 'JavaScript (server)' : codeLang}
                                            {...a11yProps(index)}
                                        ></Tab>
                                    ))}
                                </Tabs>
                            </div>
                            <div style={{ width: '100%', maxWidth: 360, order: -1, alignSelf: 'flex-end' }}>
                                <Available permission={'chatflows:update,agentflows:update'}>
                                    <TextField
                                        select
                                        fullWidth
                                        size='small'
                                        label='API access'
                                        SelectProps={{ native: true }}
                                        inputProps={{ name: 'SelectKey' }}
                                        disabled={
                                            !['off', 'shadow', 'on'].includes(rollout) ||
                                            !accessKnown ||
                                            !!accessError ||
                                            updateChatflowApi.loading
                                        }
                                        onChange={(event) => onApiKeySelected(event.target.value)}
                                        value={accessKnown ? chatflowApiKeyId : 'loading'}
                                    >
                                        {!accessKnown && <option value='loading'>Loading saved API access…</option>}
                                        {keyOptions.map((option) => (
                                            <option key={option.name} value={option.name}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </TextField>
                                </Available>
                            </div>
                        </div>
                        {!['off', 'shadow', 'on'].includes(rollout) && (
                            <p>Access settings are unavailable until the rollout status can be loaded.</p>
                        )}
                        {rollout === 'on' && isCustomAssistant && (
                            <p>
                                Custom assistants do not support exact resource grants. Existing private assistant bindings fail with
                                enforcement on. Keep enforcement off or in shadow mode for these integrations.
                            </p>
                        )}
                        {['off', 'shadow'].includes(rollout) && isCustomAssistant && (
                            <p>
                                Adding or replacing a custom assistant legacy binding is unavailable. Existing bindings can still run in off
                                or shadow mode. Select Public to remove a binding.
                            </p>
                        )}
                        <Button onClick={() => navigate('/apikey')}>Manage access keys</Button>
                        {rollout === 'on' && !isCustomAssistant && (
                            <Available permission='apikeys:create'>
                                <Button onClick={() => setCreateKeyOpen(true)}>Create key for this flow</Button>
                            </Available>
                        )}
                        {chatflowApiKeyId &&
                            apiKeys.some(
                                (key) =>
                                    key.accessPolicy?.allResources &&
                                    key.accessPolicy?.scopes?.includes('predict') &&
                                    !key.disabledAt &&
                                    (!key.expiresAt || new Date(key.expiresAt) > new Date())
                            ) && (
                                <Alert severity='warning'>
                                    Workspace-wide keys can also call this flow. Private access includes those keys; review them in Access
                                    Keys.
                                </Alert>
                            )}
                        {chatflowApiKeyId && (
                            <p>
                                Principals with a grant to this flow:{' '}
                                {apiKeys
                                    .filter(
                                        (key) =>
                                            key.accessPolicy?.allResources ||
                                            key.resources?.some((grant) => grant.resourceId === dialogProps.chatflowid)
                                    )
                                    .map((key) => key.keyName)
                                    .join(', ') || 'None'}
                                . Referenced Harnesses require additional grants.
                            </p>
                        )}
                        {chatflowApiKeyId && !selectedApiKey?.apiKey && (
                            <p>
                                Manage the many keys that may call this flow in Access Keys. Each needs this resource and the requested
                                operations. Samples use &lt;your-api-key&gt;; keep that bearer value on your server, including when using
                                JavaScript.
                            </p>
                        )}
                        <div style={{ marginTop: 10 }}></div>
                        {codes.map((codeLang, index) => (
                            <TabPanel key={index} value={value} index={index}>
                                {(codeLang === 'Embed' || codeLang === 'Share Chatbot') && chatflowApiKeyId && (
                                    <>
                                        <p>You cannot use API key while embedding/sharing chatbot.</p>
                                        <p>
                                            Please select <b>&quot;Public: anyone with the link&quot;</b> from the dropdown at the top right
                                            corner.
                                        </p>
                                    </>
                                )}
                                {codeLang === 'Embed' && !chatflowApiKeyId && <EmbedChat chatflowid={dialogProps.chatflowid} />}
                                {codeLang !== 'Embed' && codeLang !== 'Share Chatbot' && codeLang !== 'Configuration' && (
                                    <>
                                        <CopyBlock
                                            theme={atomOneDark}
                                            text={chatflowApiKeyId ? getCodeWithAuthorization(codeLang) : getCode(codeLang)}
                                            language={getLang(codeLang)}
                                            showLineNumbers={false}
                                            wrapLines
                                        />
                                        <CheckboxInput label='Show Override Config' value={checkboxVal} onChange={onCheckBoxChanged} />
                                        {checkboxVal && getConfigApi.data && getConfigApi.data.length > 0 && (
                                            <>
                                                <Typography sx={{ mt: 2 }}>
                                                    You can override existing input configuration of the chatflow with overrideConfig
                                                    property.
                                                </Typography>
                                                <div
                                                    style={{
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        borderRadius: 10,
                                                        background: 'rgb(254,252,191)',
                                                        padding: 10,
                                                        marginTop: 10,
                                                        marginBottom: 10
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            flexDirection: 'row',
                                                            alignItems: 'center'
                                                        }}
                                                    >
                                                        <IconExclamationCircle size={30} color='rgb(116,66,16)' />
                                                        <span style={{ color: 'rgb(116,66,16)', marginLeft: 10, fontWeight: 500 }}>
                                                            {
                                                                'For security reason, override config is disabled by default. You can change this by going into Chatflow Configuration -> Security tab, and enable the property you want to override.'
                                                            }
                                                            &nbsp;Refer{' '}
                                                            <a
                                                                rel='noreferrer'
                                                                target='_blank'
                                                                href='https://github.com/cuttlely/cuttlely/blob/main/README.md#override-configuration'
                                                            >
                                                                here
                                                            </a>{' '}
                                                            for more details
                                                        </span>
                                                    </div>
                                                </div>
                                                <Stack direction='column' spacing={2} sx={{ width: '100%', my: 2 }}>
                                                    <Card sx={{ borderColor: theme.palette.primary[200] + 75, p: 2 }} variant='outlined'>
                                                        <Stack
                                                            sx={{ mt: 1, mb: 2, ml: 1, alignItems: 'center' }}
                                                            direction='row'
                                                            spacing={2}
                                                        >
                                                            <IconBox />
                                                            <Typography variant='h4'>Nodes</Typography>
                                                        </Stack>
                                                        {Object.keys(nodeConfig)
                                                            .sort()
                                                            .map((nodeLabel) => (
                                                                <Accordion
                                                                    expanded={nodeConfigExpanded[nodeLabel] || false}
                                                                    onChange={handleAccordionChange(nodeLabel)}
                                                                    key={nodeLabel}
                                                                    disableGutters
                                                                >
                                                                    <AccordionSummary
                                                                        expandIcon={<ExpandMoreIcon />}
                                                                        aria-controls={`nodes-accordian-${nodeLabel}`}
                                                                        id={`nodes-accordian-header-${nodeLabel}`}
                                                                    >
                                                                        <Stack
                                                                            flexDirection='row'
                                                                            sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}
                                                                        >
                                                                            <Typography variant='h5'>{nodeLabel}</Typography>
                                                                            {nodeConfig[nodeLabel].nodeIds.length > 0 &&
                                                                                nodeConfig[nodeLabel].nodeIds.map((nodeId, index) => (
                                                                                    <div
                                                                                        key={index}
                                                                                        style={{
                                                                                            display: 'flex',
                                                                                            flexDirection: 'row',
                                                                                            width: 'max-content',
                                                                                            borderRadius: 15,
                                                                                            background: 'rgb(254,252,191)',
                                                                                            padding: 5,
                                                                                            paddingLeft: 10,
                                                                                            paddingRight: 10
                                                                                        }}
                                                                                    >
                                                                                        <span
                                                                                            style={{
                                                                                                color: 'rgb(116,66,16)',
                                                                                                fontSize: '0.825rem'
                                                                                            }}
                                                                                        >
                                                                                            {nodeId}
                                                                                        </span>
                                                                                    </div>
                                                                                ))}
                                                                        </Stack>
                                                                    </AccordionSummary>
                                                                    <AccordionDetails>
                                                                        <TableViewOnly
                                                                            rows={nodeOverrides[nodeLabel]}
                                                                            columns={
                                                                                nodeOverrides[nodeLabel].length > 0
                                                                                    ? Object.keys(nodeOverrides[nodeLabel][0]).filter(
                                                                                          (key) => key !== 'schema'
                                                                                      )
                                                                                    : []
                                                                            }
                                                                        />
                                                                    </AccordionDetails>
                                                                </Accordion>
                                                            ))}
                                                    </Card>
                                                    <Card sx={{ borderColor: theme.palette.primary[200] + 75, p: 2 }} variant='outlined'>
                                                        <Stack
                                                            sx={{ mt: 1, mb: 2, ml: 1, alignItems: 'center' }}
                                                            direction='row'
                                                            spacing={2}
                                                        >
                                                            <IconVariable />
                                                            <Typography variant='h4'>Variables</Typography>
                                                        </Stack>
                                                        <TableViewOnly rows={variableOverrides} columns={['name', 'type', 'enabled']} />
                                                    </Card>
                                                </Stack>
                                                <CopyBlock
                                                    theme={atomOneDark}
                                                    text={
                                                        chatflowApiKeyId
                                                            ? dialogProps.isFormDataRequired
                                                                ? getConfigCodeWithFormDataWithAuth(codeLang, getConfigApi.data)
                                                                : getConfigCodeWithAuthorization(codeLang, getConfigApi.data)
                                                            : dialogProps.isFormDataRequired
                                                            ? getConfigCodeWithFormData(codeLang, getConfigApi.data)
                                                            : getConfigCode(codeLang, getConfigApi.data)
                                                    }
                                                    language={getLang(codeLang)}
                                                    showLineNumbers={false}
                                                    wrapLines
                                                />
                                                <div
                                                    style={{
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        borderRadius: 10,
                                                        background: '#d8f3dc',
                                                        padding: 10,
                                                        marginTop: 10,
                                                        marginBottom: 10
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            flexDirection: 'row',
                                                            alignItems: 'center'
                                                        }}
                                                    >
                                                        <IconBulb size={30} color='#2d6a4f' />
                                                        <span style={{ color: '#2d6a4f', marginLeft: 10, fontWeight: 500 }}>
                                                            You can also specify multiple values for a config parameter by specifying the
                                                            node id
                                                        </span>
                                                    </div>
                                                    <div style={{ padding: 10 }}>
                                                        <CopyBlock
                                                            theme={atomOneDark}
                                                            text={
                                                                dialogProps.isFormDataRequired
                                                                    ? getMultiConfigCodeWithFormData(codeLang)
                                                                    : getMultiConfigCode()
                                                            }
                                                            language={getLang(codeLang)}
                                                            showLineNumbers={false}
                                                            wrapLines
                                                        />
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                        {getIsChatflowStreamingApi.data?.isStreaming && (
                                            <p>
                                                Read&nbsp;
                                                <a
                                                    rel='noreferrer'
                                                    target='_blank'
                                                    href='https://github.com/cuttlely/cuttlely/blob/main/README.md#harnesses-and-chatflows'
                                                >
                                                    here
                                                </a>
                                                &nbsp;on how to stream response back to application
                                            </p>
                                        )}
                                    </>
                                )}
                                {codeLang === 'Share Chatbot' && !chatflowApiKeyId && (
                                    <ShareChatbot isSessionMemory={dialogProps.isSessionMemory} isAgentCanvas={dialogProps.isAgentCanvas} />
                                )}
                            </TabPanel>
                        ))}
                    </>
                )}
            </DialogContent>
            {createKeyOpen && (
                <APIKeyDialog
                    show
                    dialogProps={createKeyProps}
                    onCancel={() => setCreateKeyOpen(false)}
                    onConfirm={() => {
                        setCreateKeyOpen(false)
                        getAllAPIKeysApi.request()
                    }}
                />
            )}
            <Snackbar open={!!accessMessage} autoHideDuration={5000} onClose={() => setAccessMessage('')} message={accessMessage} />
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

APICodeDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func
}

export default APICodeDialog
