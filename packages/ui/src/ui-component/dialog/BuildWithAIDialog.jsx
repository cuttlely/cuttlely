import { createPortal } from 'react-dom'
import { cloneDeep } from 'lodash'
import { useState, useEffect, useCallback } from 'react'
import PropTypes from 'prop-types'
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    LinearProgress,
    OutlinedInput,
    Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { LoadingButton } from '@mui/lab'
import { IconSparkles } from '@tabler/icons-react'
import builderApi from '@/api/builder'
import assistantsApi from '@/api/assistants'
import credentialsApi from '@/api/credentials'
import useApi from '@/hooks/useApi'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import DocStoreInputHandler from '@/views/docstore/DocStoreInputHandler'
import { baseURL, FLOWISE_CREDENTIAL_ID } from '@/store/constant'
import { initNode, showHideInputParams } from '@/utils/genericHelper'
import { BUILD_BUTTON, BUILD_EXAMPLES, BUILD_PROMPTS, buildProblemsText, recallModel, rememberModel } from '@/utils/buildWithAI'
import { keysFor, modelForKeys, modelsForKeys, onlyFit } from '@/utils/yourKey'

const KIND_WORDS = { workflow: 'workflow', harness: 'harness', etl: 'pipeline', chat: 'chatflow' }
// Harnesses and pipelines are saved as new ones right away; chatflows and workflows wait for your save.
const SAVED_AS_NEW = new Set(['harness', 'etl'])

const isMissing = (value) =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)

// Build with AI, the same on every canvas: pick the chat model that builds (remembered, from your own
// credentials, no default key), describe what you want, and get an unsaved canvas back.
const BuildWithAIDialog = ({ show, kind, onCancel, onBuilt }) => {
    const portalElement = document.getElementById('portal')
    const theme = useTheme()
    const [description, setDescription] = useState('')
    const [loading, setLoading] = useState(false)
    const [problem, setProblem] = useState('')
    const [chatModels, setChatModels] = useState([])
    const [model, setModel] = useState({})
    // Saved keys (ids and types only), so the picker can start on a model the person has a key for.
    const [credentials, setCredentials] = useState(null)
    const [showAllModels, setShowAllModels] = useState(false)
    const [moreSettings, setMoreSettings] = useState(false)
    const getChatModelsApi = useApi(assistantsApi.getChatModels)
    const prompt = BUILD_PROMPTS[kind] || 'Describe what to build'

    const setUpModel = useCallback((component, remembered) => {
        const data = initNode(cloneDeep(component), `${component.name}_0`)
        if (remembered) {
            data.inputs = { ...data.inputs, ...(remembered.inputs || {}) }
            if (remembered.credential) {
                data.credential = remembered.credential
                data.inputs[FLOWISE_CREDENTIAL_ID] = remembered.credential
            }
            data.inputParams = showHideInputParams(data)
        }
        setModel(data)
    }, [])

    useEffect(() => {
        if (show) {
            getChatModelsApi.request()
            credentialsApi
                .getAllCredentials()
                .then((response) => setCredentials(Array.isArray(response.data) ? response.data : []))
                .catch(() => setCredentials([]))
        } else {
            setDescription('')
            setProblem('')
            setLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [show])

    useEffect(() => {
        if (!getChatModelsApi.data) return
        setChatModels(getChatModelsApi.data)
        if (model?.name) return
        const remembered = recallModel()
        const component = remembered && getChatModelsApi.data.find((c) => c.name === remembered.name)
        if (component) {
            setUpModel(component, remembered)
            return
        }
        // Nothing remembered yet: start on a model the person has a key for, with that key when it is the only one.
        if (!credentials) return
        const pick = modelForKeys(getChatModelsApi.data, credentials)
        if (pick) setUpModel(pick.component, { credential: pick.credential, inputs: pick.modelName ? { modelName: pick.modelName } : {} })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getChatModelsApi.data, credentials])

    const onModelChange = ({ inputParam, newValue }) => {
        setModel((previous) => {
            const next = { ...previous }
            if (inputParam.type === 'credential') {
                next.credential = newValue
                next.inputs = { ...next.inputs, [FLOWISE_CREDENTIAL_ID]: newValue }
            } else {
                next.inputs = { ...next.inputs, [inputParam.name]: newValue }
            }
            next.inputParams = showHideInputParams(next)
            return next
        })
    }

    const paramMissing = (param) =>
        param.type === 'credential' ? !(model.credential || model.inputs?.[FLOWISE_CREDENTIAL_ID]) : isMissing(model.inputs?.[param.name])

    const missingFields = () => {
        if (!model?.name) return ['Chat model']
        return showHideInputParams(model)
            .filter((param) => !param.hidden && param.display !== false && !param.optional)
            .filter(paramMissing)
            .map((param) => param.label || param.name)
    }
    const ready = description.trim() && missingFields().length === 0

    // The list starts with the models the person has a key for; every model is one click away.
    const yourModels = modelsForKeys(chatModels, credentials || [])
    const listedModels =
        showAllModels || yourModels.length === 0
            ? chatModels
            : [...yourModels, ...chatModels.filter((c) => c.name === model?.name && !yourModels.includes(c))]
    // Advanced settings wait behind More settings, unless one is required and still empty.
    const visibleParams = model?.name ? showHideInputParams(model).filter((param) => !param.hidden && param.display !== false) : []
    const basicParams = visibleParams.filter((param) => !param.additionalParams || (!param.optional && paramMissing(param)))
    const advancedParams = visibleParams.filter((param) => !basicParams.includes(param))

    const onBuild = async () => {
        if (!ready) return
        setLoading(true)
        setProblem('')
        try {
            rememberModel(model)
            const response = await builderApi.build(kind, { question: description.trim(), selectedChatModel: model })
            const result = response.data
            if (result?.ok) {
                onBuilt(result)
            } else {
                setProblem(buildProblemsText(KIND_WORDS[kind] || kind, result?.problems || ['No plan came back.']))
            }
        } catch (error) {
            setProblem(error?.response?.data?.message || error?.message || 'The build failed.')
        } finally {
            setLoading(false)
        }
    }

    const component = show ? (
        <Dialog fullWidth maxWidth='md' open={show} onClose={loading ? undefined : onCancel} aria-labelledby='build-with-ai-title'>
            <DialogTitle sx={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 1 }} id='build-with-ai-title'>
                <IconSparkles size={20} />
                {BUILD_BUTTON}
            </DialogTitle>
            <DialogContent>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                    {SAVED_AS_NEW.has(kind)
                        ? `It builds a first version you can change and saves it as a new ${KIND_WORDS[kind]}. Every part is checked before it lands.`
                        : 'It builds a first version you can change. Nothing is saved until you save, and every part is checked before it lands.'}
                </Typography>
                <Typography sx={{ mb: 1 }}>{prompt}</Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                    {(BUILD_EXAMPLES[kind] || []).map((example) => (
                        <Button
                            key={example}
                            size='small'
                            variant='outlined'
                            color='inherit'
                            disabled={loading}
                            sx={{ textTransform: 'none', borderRadius: '16px' }}
                            onClick={() => setDescription(example)}
                        >
                            {example}
                        </Button>
                    ))}
                </Box>
                <OutlinedInput
                    sx={{ width: '100%' }}
                    multiline
                    rows={6}
                    disabled={loading}
                    value={description}
                    placeholder={prompt}
                    inputProps={{ 'aria-label': prompt }}
                    onChange={(event) => setDescription(event.target.value)}
                />
                <Box sx={{ mt: 2 }}>
                    <Typography>
                        Chat model that builds<span style={{ color: 'red' }}>&nbsp;*</span>
                    </Typography>
                    <Typography variant='caption' color='text.secondary'>
                        Uses a credential from your Credentials page. Your choice is remembered.
                    </Typography>
                    <Dropdown
                        key={model?.name || 'none'}
                        name='builderChatModel'
                        disabled={loading}
                        options={listedModels.map((c) => ({
                            label: c.label,
                            name: c.name,
                            imageSrc: `${baseURL}/api/v1/node-icon/${c.name}`
                        }))}
                        onSelect={(name) => {
                            const found = chatModels.find((c) => c.name === name)
                            const credential = found ? onlyFit(keysFor(found, credentials || [])) : ''
                            if (found) setUpModel(found, credential ? { credential } : undefined)
                            else setModel({})
                        }}
                        value={model?.name || 'choose an option'}
                    />
                    {yourModels.length > 0 && chatModels.length > yourModels.length && (
                        <Button
                            size='small'
                            disabled={loading}
                            onClick={() => setShowAllModels((value) => !value)}
                            sx={{ mt: 0.5, textTransform: 'none' }}
                        >
                            {showAllModels ? 'Only models for your keys' : `Show all ${chatModels.length} models`}
                        </Button>
                    )}
                </Box>
                {model?.name && (
                    <Box sx={{ mt: 1, border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2 }}>
                        {basicParams.map((param) => (
                            <DocStoreInputHandler key={param.name} inputParam={param} data={model} onNodeDataChange={onModelChange} />
                        ))}
                        {advancedParams.length > 0 && (
                            <Box sx={{ px: 2, pb: 1 }}>
                                <Button size='small' onClick={() => setMoreSettings((value) => !value)} sx={{ textTransform: 'none' }}>
                                    {moreSettings ? 'Fewer settings' : `More settings (${advancedParams.length})`}
                                </Button>
                            </Box>
                        )}
                        {moreSettings &&
                            advancedParams.map((param) => (
                                <DocStoreInputHandler key={param.name} inputParam={param} data={model} onNodeDataChange={onModelChange} />
                            ))}
                    </Box>
                )}
                {loading && (
                    <Box sx={{ mt: 2 }} role='status'>
                        <Typography variant='body2' sx={{ mb: 1 }}>
                            Planning, checking and placing the parts. This can take a minute.
                        </Typography>
                        <LinearProgress />
                    </Box>
                )}
                {problem && (
                    <Alert severity='warning' sx={{ mt: 2 }}>
                        {problem}
                    </Alert>
                )}
            </DialogContent>
            <DialogActions sx={{ pb: 3, pr: 3 }}>
                <Button onClick={onCancel} disabled={loading}>
                    Cancel
                </Button>
                <LoadingButton
                    loading={loading}
                    variant='contained'
                    startIcon={<IconSparkles size={18} />}
                    disabled={!ready || loading}
                    onClick={onBuild}
                >
                    Build
                </LoadingButton>
            </DialogActions>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

BuildWithAIDialog.propTypes = {
    show: PropTypes.bool,
    kind: PropTypes.oneOf(['workflow', 'harness', 'etl', 'chat']).isRequired,
    onCancel: PropTypes.func,
    onBuilt: PropTypes.func
}

export default BuildWithAIDialog
