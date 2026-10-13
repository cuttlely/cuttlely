import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'
import { useSelector, useDispatch } from 'react-redux'
import { useEffect, useMemo, useRef, useState } from 'react'

// material-ui
import { useTheme, styled, alpha } from '@mui/material/styles'
import { Alert, Avatar, Box, ButtonBase, Chip, Typography, Stack, Switch, TextField, Button, Tooltip } from '@mui/material'
import useMediaQuery from '@mui/material/useMediaQuery'

// icons
import {
    IconSettings,
    IconChevronLeft,
    IconDeviceFloppy,
    IconPencil,
    IconCheck,
    IconX,
    IconCode,
    IconAlertTriangleFilled,
    IconHistory
} from '@tabler/icons-react'

// project imports
import Settings from '@/views/settings'
import FlowiseMigrationWizard from '@/ui-component/flow/FlowiseMigrationWizard'
import SaveChatflowDialog from '@/ui-component/dialog/SaveChatflowDialog'
import APICodeDialog from '@/views/chatflows/APICodeDialog'
import ViewMessagesDialog from '@/ui-component/dialog/ViewMessagesDialog'
import ChatflowConfigurationDialog from '@/ui-component/dialog/ChatflowConfigurationDialog'
import UpsertHistoryDialog from '@/views/vectorstore/UpsertHistoryDialog'
import ViewLeadsDialog from '@/ui-component/dialog/ViewLeadsDialog'
import ExportAsTemplateDialog from '@/ui-component/dialog/ExportAsTemplateDialog'
import { Available } from '@/ui-component/rbac/available'
import { canvasNamePermission, canvasSaveButtonPermission, canvasUpdatePermission } from './canvasSavePermission'
import VersionHistoryDrawer from '@/views/canvas/VersionHistoryDrawer'
import PublishDialog from '@/views/canvas/PublishDialog'

// API
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import flowVersionsApi from '@/api/flowVersions'
import { exactTime, lastEditedText, lastEditedVersion } from '@/utils/versionHistory'
import { STALE_DRAFT_WARNING, apiErrorMessage, badgeText, draftBadge, showDraftChrome } from '@/utils/flowDrafts'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'

// utils
import { generateExportFlowData } from '@/utils/genericHelper'
import { exportKnownNodeNames } from '@/utils/missingNode'
import { saveFlowPlaceholder } from '@/utils/saveFlowPlaceholder'
import { uiBaseURL } from '@/store/constant'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction, SET_CHATFLOW } from '@/store/actions'

// Clock icon (unchecked) and calendar-check icon (checked), mirroring MaterialUISwitch style
const clockIcon = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 20 20"><path fill="${encodeURIComponent(
    '#fff'
)}" d="M10 2a8 8 0 108 8 8 8 0 00-8-8zm0 14.5A6.5 6.5 0 1116.5 10 6.5 6.5 0 0110 16.5zM10.75 5.5h-1.5v5l4 2.4.75-1.23-3.25-1.92z"/></svg>')`
const clockCheckIcon = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${encodeURIComponent(
    '#fff'
)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.942 13.021a9 9 0 1 0 -9.407 7.967"/><path d="M12 7v5l3 3"/><path d="M15 19l2 2l4 -4"/></svg>')`

const ScheduleSwitch = styled(Switch, { shouldForwardProp: (prop) => prop !== 'isDark' })(({ theme, isDark }) => {
    const offTrack = isDark ? alpha(theme.palette.success.main, 0.1) : alpha(theme.palette.success.main, 0.12)
    const offThumb = isDark ? '#4a5662' : alpha(theme.palette.success.main, 0.25)
    return {
        width: 62,
        height: 34,
        padding: 7,
        '& .MuiSwitch-switchBase': {
            margin: 1,
            padding: 0,
            transform: 'translateX(6px)',
            '&.Mui-checked': {
                color: '#fff',
                transform: 'translateX(22px)',
                '& .MuiSwitch-thumb': {
                    backgroundColor: theme.palette.success.dark
                },
                '& .MuiSwitch-thumb:before': {
                    backgroundImage: clockCheckIcon
                },
                '& + .MuiSwitch-track': {
                    opacity: 1,
                    backgroundColor: theme.palette.success.light
                }
            }
        },
        '& .MuiSwitch-thumb': {
            backgroundColor: offThumb,
            width: 32,
            height: 32,
            '&:before': {
                content: "''",
                position: 'absolute',
                width: '100%',
                height: '100%',
                left: 0,
                top: 0,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundImage: clockIcon,
                opacity: 0.9
            }
        },
        '& .MuiSwitch-track': {
            opacity: 1,
            backgroundColor: offTrack,
            borderRadius: 20 / 2
        },
        '&.Mui-disabled .MuiSwitch-thumb, & .Mui-disabled .MuiSwitch-thumb': {
            backgroundColor: offThumb
        },
        '&.Mui-disabled + .MuiSwitch-track, & .Mui-disabled + .MuiSwitch-track': {
            backgroundColor: offTrack,
            opacity: 1
        }
    }
})

const LockedScheduleSwitch = styled(ScheduleSwitch, { shouldForwardProp: (prop) => prop !== 'isDark' })(({ theme, isDark }) => ({
    '& .MuiSwitch-track, &.Mui-disabled + .MuiSwitch-track, & .Mui-disabled + .MuiSwitch-track': {
        backgroundColor: isDark ? alpha(theme.palette.warning.main, 0.2) : alpha(theme.palette.warning.main, 0.15),
        border: `1px solid ${alpha(theme.palette.warning.main, isDark ? 0.6 : 0.5)}`,
        opacity: 1
    },
    '&.Mui-disabled .MuiSwitch-thumb, & .Mui-disabled .MuiSwitch-thumb': {
        backgroundColor: isDark ? '#4a3e1f' : '#f5e6b8'
    }
}))

// ==============================|| CANVAS HEADER ||============================== //

const CanvasHeader = ({
    chatflow,
    isAgentCanvas,
    isHarnessCanvas,
    isAgentflowV2,
    isEtlCanvas,
    handleSaveFlow,
    handleDeleteFlow,
    handleLoadFlow,
    onApplyMigration,
    draftStatus = null,
    onDraftStatus = () => undefined,
    onChatflowUpdated = () => undefined,
    onApplyCanvas = () => undefined
}) => {
    const theme = useTheme()
    // Below md the actions sit on a second row. Below sm the draft label uses the short word.
    const compact = useMediaQuery(theme.breakpoints.down('sm'))
    const stacked = useMediaQuery(theme.breakpoints.down('md'))
    const dispatch = useDispatch()
    const navigate = useNavigate()
    const { confirm } = useConfirm()
    const flowNameRef = useRef()
    const settingsRef = useRef()

    const [isEditingFlowName, setEditingFlowName] = useState(null)
    const [flowName, setFlowName] = useState('')
    const [isSettingsOpen, setSettingsOpen] = useState(false)
    const [flowDialogOpen, setFlowDialogOpen] = useState(false)
    const [apiDialogOpen, setAPIDialogOpen] = useState(false)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [publishOpen, setPublishOpen] = useState(false)
    const [versioningEnabled, setVersioningEnabled] = useState(false)
    const [apiDialogProps, setAPIDialogProps] = useState({})
    const [viewMessagesDialogOpen, setViewMessagesDialogOpen] = useState(false)
    const [viewMessagesDialogProps, setViewMessagesDialogProps] = useState({})
    const [viewLeadsDialogOpen, setViewLeadsDialogOpen] = useState(false)
    const [viewLeadsDialogProps, setViewLeadsDialogProps] = useState({})
    const [upsertHistoryDialogOpen, setUpsertHistoryDialogOpen] = useState(false)
    const [upsertHistoryDialogProps, setUpsertHistoryDialogProps] = useState({})
    const [chatflowConfigurationDialogOpen, setChatflowConfigurationDialogOpen] = useState(false)
    const [chatflowConfigurationDialogProps, setChatflowConfigurationDialogProps] = useState({})

    const [exportAsTemplateDialogOpen, setExportAsTemplateDialogOpen] = useState(false)
    const [exportAsTemplateDialogProps, setExportAsTemplateDialogProps] = useState({})
    const [migrationOpen, setMigrationOpen] = useState(false)
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const draftPermission = canvasUpdatePermission(isAgentCanvas)
    const namePermission = canvasNamePermission(isAgentCanvas)
    const saveButtonPermission = canvasSaveButtonPermission(isAgentCanvas, {
        hasId: Boolean(chatflow?.id),
        draftMode: showDraftChrome(draftStatus)
    })

    const title = isEtlCanvas ? 'Pipeline' : isHarnessCanvas ? 'Harness' : isAgentCanvas ? 'Agents' : 'Chatflow'

    const updateChatflowApi = useApi(chatflowsApi.updateChatflow)
    const getScheduleStatusApi = useApi(chatflowsApi.getScheduleStatus)
    const toggleScheduleEnabledApi = useApi(chatflowsApi.toggleScheduleEnabled)
    const canvas = useSelector((state) => state.canvas)
    const isDark = useSelector((state) => state.customization.isDarkMode)

    const [scheduleEnabled, setScheduleEnabled] = useState(false)
    const [scheduleCanEnable, setScheduleCanEnable] = useState(false)
    const [scheduleCanEnableReason, setScheduleCanEnableReason] = useState('')
    const [scheduleStatusLoaded, setScheduleStatusLoaded] = useState(false)

    const isScheduleFlow = useMemo(() => {
        if (!chatflow?.flowData || !isAgentflowV2) return false
        try {
            const parsed = JSON.parse(chatflow.flowData)
            const startNode = (parsed.nodes || []).find((n) => n.data?.name === 'startAgentflow')
            return startNode?.data?.inputs?.startInputType === 'scheduleInput'
        } catch {
            return false
        }
    }, [chatflow?.flowData, isAgentflowV2])

    const onSettingsItemClick = (setting) => {
        setSettingsOpen(false)

        if (setting === 'deleteChatflow') {
            handleDeleteFlow()
        } else if (setting === 'viewMessages') {
            setViewMessagesDialogProps({
                title: 'View Messages',
                chatflow: chatflow,
                isChatflow: isAgentflowV2 ? false : true
            })
            setViewMessagesDialogOpen(true)
        } else if (setting === 'viewLeads') {
            setViewLeadsDialogProps({
                title: 'View Leads',
                chatflow: chatflow
            })
            setViewLeadsDialogOpen(true)
        } else if (setting === 'saveAsTemplate') {
            if (canvas.isDirty) {
                enqueueSnackbar({
                    message: 'Please save the flow before exporting as template',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'error',
                        persist: true,
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                return
            }
            setExportAsTemplateDialogProps({
                title: 'Export As Template',
                chatflow: chatflow
            })
            setExportAsTemplateDialogOpen(true)
        } else if (setting === 'viewUpsertHistory') {
            setUpsertHistoryDialogProps({
                title: 'View Upsert History',
                chatflow: chatflow
            })
            setUpsertHistoryDialogOpen(true)
        } else if (setting === 'chatflowConfiguration') {
            setChatflowConfigurationDialogProps({
                title: `${title} Configuration`,
                chatflow,
                draftStatus,
                onDraftStatus
            })
            setChatflowConfigurationDialogOpen(true)
        } else if (setting === 'duplicateChatflow') {
            try {
                let flowData = chatflow.flowData
                const parsedFlowData = JSON.parse(flowData)
                flowData = JSON.stringify(parsedFlowData)
                localStorage.setItem('duplicatedFlowData', flowData)
                if (isAgentflowV2) {
                    window.open(`${uiBaseURL}/v2/agentcanvas`, '_blank')
                } else if (isAgentCanvas) {
                    window.open(`${uiBaseURL}/agentcanvas`, '_blank')
                } else {
                    window.open(`${uiBaseURL}/canvas`, '_blank')
                }
            } catch (e) {
                console.error(e)
            }
        } else if (setting === 'exportChatflow') {
            try {
                const flowData = JSON.parse(chatflow.flowData)
                let dataStr = JSON.stringify(generateExportFlowData(flowData, exportKnownNodeNames(canvas.componentNodes)), null, 2)
                //let dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr)
                const blob = new Blob([dataStr], { type: 'application/json' })
                const dataUri = URL.createObjectURL(blob)

                let exportFileDefaultName = `${chatflow.name} ${title}.json`

                let linkElement = document.createElement('a')
                linkElement.setAttribute('href', dataUri)
                linkElement.setAttribute('download', exportFileDefaultName)
                linkElement.click()
            } catch (e) {
                console.error(e)
            }
        }
    }

    const onUploadFile = (file, expect) => {
        setSettingsOpen(false)
        handleLoadFlow(file, expect)
    }

    const submitFlowName = () => {
        if (chatflow.id) {
            const updateBody = {
                name: flowNameRef.current.value
            }
            updateChatflowApi.request(chatflow.id, updateBody)
        }
    }

    const onAPIDialogClick = () => {
        // If file type is file, isFormDataRequired = true
        let isFormDataRequired = false
        try {
            const flowData = JSON.parse(chatflow.flowData)
            const nodes = flowData.nodes
            for (const node of nodes) {
                if (node.data.inputParams.find((param) => param.type === 'file')) {
                    isFormDataRequired = true
                    break
                }
            }
        } catch (e) {
            console.error(e)
        }

        // If sessionId memory, isSessionMemory = true
        let isSessionMemory = false
        try {
            const flowData = JSON.parse(chatflow.flowData)
            const nodes = flowData.nodes
            for (const node of nodes) {
                if (node.data.inputParams.find((param) => param.name === 'sessionId')) {
                    isSessionMemory = true
                    break
                }
            }
        } catch (e) {
            console.error(e)
        }

        setAPIDialogProps({
            title: 'Embed in website or use as API',
            chatflowid: chatflow.id,
            chatflowApiKeyId: chatflow.apikeyid,
            isFormDataRequired,
            isSessionMemory,
            isAgentCanvas,
            isAgentflowV2
        })
        setAPIDialogOpen(true)
    }

    const onSaveChatflowClick = () => {
        if (chatflow.id) handleSaveFlow(flowName)
        else setFlowDialogOpen(true)
    }

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.repeat) return
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
            event.preventDefault()
            const target = event.target
            if (target && typeof target.closest === 'function') {
                const field = target.closest('input, textarea, [contenteditable="true"]')
                const dialog = target.closest('[role="dialog"]')
                if (field && dialog) return
            }
            if (!chatflow) return
            onSaveChatflowClick()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatflow?.id, flowName, handleSaveFlow])

    const onConfirmSaveName = (flowName) => {
        setFlowDialogOpen(false)
        handleSaveFlow(flowName)
    }

    useEffect(() => {
        if (updateChatflowApi.data) {
            setFlowName(updateChatflowApi.data.name)
            dispatch({ type: SET_CHATFLOW, chatflow: updateChatflowApi.data })
        }
        setEditingFlowName(false)

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [updateChatflowApi.data])

    useEffect(() => {
        if (chatflow) {
            setFlowName(chatflow.name)
            // if configuration dialog is open, update its data
            if (chatflowConfigurationDialogOpen) {
                setChatflowConfigurationDialogProps({
                    title: `${title} Configuration`,
                    chatflow,
                    draftStatus,
                    onDraftStatus
                })
            }
        }
    }, [chatflow, title, chatflowConfigurationDialogOpen, draftStatus, onDraftStatus])

    // Version history shows when the server keeps it: on by default, off with CUTTLELY_VERSIONS=off.
    useEffect(() => {
        let cancelled = false
        flowVersionsApi
            .getStatus()
            .then((res) => !cancelled && setVersioningEnabled(Boolean(res.data?.enabled)))
            .catch(() => !cancelled && setVersioningEnabled(false))
        return () => {
            cancelled = true
        }
    }, [])

    // "Last edited by" under the flow name, from the newest version.
    const [lastVersion, setLastVersion] = useState(null)
    useEffect(() => {
        if (!versioningEnabled || !chatflow?.id) {
            setLastVersion(null)
            return
        }
        let cancelled = false
        flowVersionsApi
            .listVersions(chatflow.id)
            .then((res) => !cancelled && setLastVersion(lastEditedVersion(res.data)))
            .catch(() => !cancelled && setLastVersion(null))
        return () => {
            cancelled = true
        }
    }, [versioningEnabled, chatflow?.id, chatflow?.updatedDate])

    useEffect(() => {
        if (chatflow?.id && isScheduleFlow) {
            setScheduleStatusLoaded(false)
            getScheduleStatusApi.request(chatflow.id)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatflow?.id, chatflow?.updatedDate, isScheduleFlow])

    useEffect(() => {
        if (getScheduleStatusApi.data) {
            setScheduleEnabled(getScheduleStatusApi.data.enabled ?? false)
            setScheduleCanEnable(getScheduleStatusApi.data.canEnable ?? false)
            setScheduleCanEnableReason(getScheduleStatusApi.data.reason || '')
            setScheduleStatusLoaded(true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getScheduleStatusApi.data])

    useEffect(() => {
        if (toggleScheduleEnabledApi.data) {
            setScheduleEnabled(toggleScheduleEnabledApi.data.enabled ?? false)
            enqueueSnackbar({
                message: `Schedule ${toggleScheduleEnabledApi.data.enabled ? 'enabled' : 'disabled'} successfully`,
                options: { variant: 'success' }
            })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toggleScheduleEnabledApi.data])

    useEffect(() => {
        if (toggleScheduleEnabledApi.error) {
            enqueueSnackbar({
                message: String(toggleScheduleEnabledApi.error?.message || toggleScheduleEnabledApi.error || 'Failed to toggle schedule'),
                options: { variant: 'error' }
            })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toggleScheduleEnabledApi.error])

    const handleToggleSchedule = (newEnabled) => {
        toggleScheduleEnabledApi.request(chatflow.id, newEnabled)
    }

    const badge = draftBadge(draftStatus)

    const discardDraft = async () => {
        if (!chatflow?.id) return
        const ok = await confirm({
            title: 'Discard draft?',
            description: canvas.isDirty
                ? 'The canvas goes back to Live. Live itself does not change. Edits you have not saved are discarded too.'
                : 'The canvas goes back to Live. Live itself does not change.',
            confirmButtonName: 'Discard draft',
            cancelButtonName: 'Keep editing'
        })
        if (!ok) return
        try {
            const res = await flowDraftsApi.discardDraft(chatflow.id)
            onDraftStatus(res.data)
            onApplyCanvas(chatflow.flowData || '')
            setPublishOpen(false)
            enqueueSnackbar({
                message: 'Draft discarded. Live is unchanged.',
                options: { key: new Date().getTime() + Math.random(), variant: 'success' }
            })
        } catch (error) {
            enqueueSnackbar({
                message: apiErrorMessage(error, 'The draft could not be discarded.'),
                options: { key: new Date().getTime() + Math.random(), variant: 'error', persist: true }
            })
        }
    }

    const onRolledBack = (data) => {
        if (data?.status) onDraftStatus(data.status)
        if (data?.chatflow) onChatflowUpdated(data.chatflow)
        if (!data?.status?.draft) onApplyCanvas(data?.chatflow?.flowData || '')
        enqueueSnackbar({
            message: data?.status?.draft ? 'Rolled back Live. Your draft is still here.' : 'Rolled back Live.',
            options: { key: new Date().getTime() + Math.random(), variant: 'success' }
        })
    }

    return (
        <>
            <Stack
                flexDirection='row'
                justifyContent='space-between'
                alignItems='center'
                sx={{ width: '100%', flexWrap: { xs: 'wrap', md: 'nowrap' }, rowGap: 1 }}
            >
                <Stack flexDirection='row' sx={{ width: '100%', maxWidth: { xs: '100%', md: '50%' }, minWidth: 0 }}>
                    <Box>
                        <ButtonBase title='Back' sx={{ borderRadius: '50%' }}>
                            <Avatar
                                variant='rounded'
                                sx={{
                                    ...theme.typography.commonAvatar,
                                    ...theme.typography.mediumAvatar,
                                    transition: 'all .2s ease-in-out',
                                    background: theme.palette.secondary.light,
                                    color: theme.palette.secondary.dark,
                                    '&:hover': {
                                        background: theme.palette.secondary.dark,
                                        color: theme.palette.secondary.light
                                    }
                                }}
                                color='inherit'
                                onClick={() => {
                                    if (isEtlCanvas) {
                                        navigate('/etl')
                                    } else if (window.history.state && window.history.state.idx > 0) {
                                        navigate(-1)
                                    } else {
                                        navigate('/', { replace: true })
                                    }
                                }}
                            >
                                <IconChevronLeft stroke={1.5} size='1.3rem' />
                            </Avatar>
                        </ButtonBase>
                    </Box>
                    <Box sx={{ width: '100%' }}>
                        {!isEditingFlowName ? (
                            <>
                                <Stack flexDirection='row' alignItems='center' sx={{ minWidth: 0 }}>
                                    <Typography
                                        sx={{
                                            fontSize: '1.5rem',
                                            fontWeight: 600,
                                            ml: 2,
                                            textOverflow: 'ellipsis',
                                            overflow: 'hidden',
                                            whiteSpace: 'nowrap',
                                            minWidth: 0
                                        }}
                                    >
                                        {canvas.isDirty && <strong style={{ color: theme.palette.orange.main }}>*</strong>} {flowName}
                                    </Typography>
                                    {badge && (
                                        <Chip
                                            data-testid='draft-label'
                                            size='small'
                                            label={badgeText(badge, compact)}
                                            color={badge.tone === 'draft' ? 'warning' : 'success'}
                                            sx={{ ml: 1, flexShrink: 0, fontWeight: 600 }}
                                        />
                                    )}
                                    {chatflow?.id && (
                                        <Available permission={namePermission}>
                                            <ButtonBase title='Edit Name' sx={{ borderRadius: '50%' }}>
                                                <Avatar
                                                    variant='rounded'
                                                    sx={{
                                                        ...theme.typography.commonAvatar,
                                                        ...theme.typography.mediumAvatar,
                                                        transition: 'all .2s ease-in-out',
                                                        ml: 1,
                                                        background: theme.palette.secondary.light,
                                                        color: theme.palette.secondary.dark,
                                                        '&:hover': {
                                                            background: theme.palette.secondary.dark,
                                                            color: theme.palette.secondary.light
                                                        }
                                                    }}
                                                    color='inherit'
                                                    onClick={() => setEditingFlowName(true)}
                                                >
                                                    <IconPencil stroke={1.5} size='1.3rem' />
                                                </Avatar>
                                            </ButtonBase>
                                        </Available>
                                    )}
                                </Stack>
                                {lastVersion && (
                                    <Typography
                                        variant='caption'
                                        color='text.secondary'
                                        title={exactTime(lastVersion.date)}
                                        data-testid='last-edited'
                                        sx={{
                                            display: 'block',
                                            ml: 2,
                                            mt: -0.25,
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis'
                                        }}
                                    >
                                        {lastEditedText(lastVersion)}
                                    </Typography>
                                )}
                            </>
                        ) : (
                            <Stack flexDirection='row' sx={{ width: '100%' }}>
                                <TextField
                                    //eslint-disable-next-line jsx-a11y/no-autofocus
                                    autoFocus
                                    size='small'
                                    inputRef={flowNameRef}
                                    sx={{
                                        width: '100%',
                                        ml: 2
                                    }}
                                    defaultValue={flowName}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            submitFlowName()
                                        } else if (e.key === 'Escape') {
                                            setEditingFlowName(false)
                                        }
                                    }}
                                />
                                <ButtonBase title='Save Name' sx={{ borderRadius: '50%' }}>
                                    <Avatar
                                        variant='rounded'
                                        sx={{
                                            ...theme.typography.commonAvatar,
                                            ...theme.typography.mediumAvatar,
                                            transition: 'all .2s ease-in-out',
                                            background: theme.palette.success.light,
                                            color: theme.palette.success.dark,
                                            ml: 1,
                                            '&:hover': {
                                                background: theme.palette.success.dark,
                                                color: theme.palette.success.light
                                            }
                                        }}
                                        color='inherit'
                                        onClick={submitFlowName}
                                    >
                                        <IconCheck stroke={1.5} size='1.3rem' />
                                    </Avatar>
                                </ButtonBase>
                                <ButtonBase title='Cancel' sx={{ borderRadius: '50%' }}>
                                    <Avatar
                                        variant='rounded'
                                        sx={{
                                            ...theme.typography.commonAvatar,
                                            ...theme.typography.mediumAvatar,
                                            transition: 'all .2s ease-in-out',
                                            background: theme.palette.error.light,
                                            color: theme.palette.error.dark,
                                            ml: 1,
                                            '&:hover': {
                                                background: theme.palette.error.dark,
                                                color: theme.palette.error.light
                                            }
                                        }}
                                        color='inherit'
                                        onClick={() => setEditingFlowName(false)}
                                    >
                                        <IconX stroke={1.5} size='1.3rem' />
                                    </Avatar>
                                </ButtonBase>
                            </Stack>
                        )}
                    </Box>
                </Stack>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        flexBasis: { xs: '100%', md: 'auto' },
                        justifyContent: 'flex-end'
                    }}
                >
                    {chatflow?.id && isAgentflowV2 && isScheduleFlow && scheduleStatusLoaded && (
                        <Tooltip
                            title={
                                scheduleEnabled
                                    ? 'Schedule active — click to disable'
                                    : scheduleCanEnable
                                    ? 'Schedule inactive — click to enable'
                                    : scheduleCanEnableReason || 'Fix the schedule configuration to enable'
                            }
                        >
                            <Box
                                sx={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    verticalAlign: 'middle',
                                    mr: 2,
                                    gap: 0.5
                                }}
                            >
                                {!scheduleCanEnable && !scheduleEnabled ? (
                                    <>
                                        <IconAlertTriangleFilled size={16} color={theme.palette.warning.main} style={{ marginRight: 4 }} />
                                        <LockedScheduleSwitch checked={false} disabled isDark={isDark} />
                                    </>
                                ) : (
                                    <ScheduleSwitch
                                        checked={scheduleEnabled}
                                        onChange={(e) => handleToggleSchedule(e.target.checked)}
                                        isDark={isDark}
                                    />
                                )}
                            </Box>
                        </Tooltip>
                    )}
                    {chatflow?.id && versioningEnabled && (
                        <ButtonBase title='Version history' sx={{ borderRadius: '50%', mr: 2 }}>
                            <Avatar
                                variant='rounded'
                                sx={{
                                    ...theme.typography.commonAvatar,
                                    ...theme.typography.mediumAvatar,
                                    transition: 'all .2s ease-in-out',
                                    background: theme.palette.canvasHeader.deployLight,
                                    color: theme.palette.canvasHeader.deployDark,
                                    '&:hover': {
                                        background: theme.palette.canvasHeader.deployDark,
                                        color: theme.palette.canvasHeader.deployLight
                                    }
                                }}
                                color='inherit'
                                aria-label='Version history'
                                onClick={() => setHistoryOpen(true)}
                            >
                                <IconHistory stroke={1.5} size='1.3rem' />
                            </Avatar>
                        </ButtonBase>
                    )}
                    {chatflow?.id && !isEtlCanvas && (
                        <ButtonBase title='API Endpoint' sx={{ borderRadius: '50%', mr: 2 }}>
                            <Avatar
                                variant='rounded'
                                sx={{
                                    ...theme.typography.commonAvatar,
                                    ...theme.typography.mediumAvatar,
                                    transition: 'all .2s ease-in-out',
                                    background: theme.palette.canvasHeader.deployLight,
                                    color: theme.palette.canvasHeader.deployDark,
                                    '&:hover': {
                                        background: theme.palette.canvasHeader.deployDark,
                                        color: theme.palette.canvasHeader.deployLight
                                    }
                                }}
                                color='inherit'
                                onClick={onAPIDialogClick}
                            >
                                <IconCode stroke={1.5} size='1.3rem' />
                            </Avatar>
                        </ButtonBase>
                    )}
                    {showDraftChrome(draftStatus) && (
                        <Available permission={draftPermission}>
                            <Button
                                variant='contained'
                                size='small'
                                data-testid='publish-button'
                                disabled={!draftStatus?.draft}
                                onClick={() => setPublishOpen(true)}
                                sx={{ mr: 2, borderRadius: 2, textTransform: 'none', whiteSpace: 'nowrap' }}
                            >
                                Publish
                            </Button>
                        </Available>
                    )}
                    <Available permission={saveButtonPermission}>
                        <ButtonBase title={`Save ${title}`} sx={{ borderRadius: '50%', mr: 2 }}>
                            <Avatar
                                variant='rounded'
                                sx={{
                                    ...theme.typography.commonAvatar,
                                    ...theme.typography.mediumAvatar,
                                    transition: 'all .2s ease-in-out',
                                    background: theme.palette.canvasHeader.saveLight,
                                    color: theme.palette.canvasHeader.saveDark,
                                    '&:hover': {
                                        background: theme.palette.canvasHeader.saveDark,
                                        color: theme.palette.canvasHeader.saveLight
                                    }
                                }}
                                color='inherit'
                                onClick={onSaveChatflowClick}
                            >
                                <IconDeviceFloppy stroke={1.5} size='1.3rem' />
                            </Avatar>
                        </ButtonBase>
                    </Available>
                    <ButtonBase ref={settingsRef} title='Settings' sx={{ borderRadius: '50%' }}>
                        <Avatar
                            variant='rounded'
                            sx={{
                                ...theme.typography.commonAvatar,
                                ...theme.typography.mediumAvatar,
                                transition: 'all .2s ease-in-out',
                                background: theme.palette.canvasHeader.settingsLight,
                                color: theme.palette.canvasHeader.settingsDark,
                                '&:hover': {
                                    background: theme.palette.canvasHeader.settingsDark,
                                    color: theme.palette.canvasHeader.settingsLight
                                }
                            }}
                            onClick={() => setSettingsOpen(!isSettingsOpen)}
                        >
                            <IconSettings stroke={1.5} size='1.3rem' />
                        </Avatar>
                    </ButtonBase>
                </Box>
            </Stack>
            {draftStatus?.draft?.stale && (
                <Alert
                    severity='warning'
                    data-testid='stale-draft-banner'
                    sx={{
                        position: 'fixed',
                        top: stacked ? 120 : 72,
                        left: 0,
                        right: 0,
                        zIndex: theme.zIndex.appBar,
                        borderRadius: 0
                    }}
                    action={
                        <Available permission={draftPermission}>
                            <Stack direction='row' spacing={1}>
                                <Button color='inherit' size='small' onClick={() => setPublishOpen(true)}>
                                    Review
                                </Button>
                                <Button color='inherit' size='small' onClick={discardDraft}>
                                    Discard draft
                                </Button>
                            </Stack>
                        </Available>
                    }
                >
                    {STALE_DRAFT_WARNING}
                </Alert>
            )}
            <Settings
                chatflow={chatflow}
                isSettingsOpen={isSettingsOpen}
                anchorEl={settingsRef.current}
                onClose={() => setSettingsOpen(false)}
                onSettingsItemClick={onSettingsItemClick}
                onUploadFile={onUploadFile}
                isAgentCanvas={isAgentCanvas}
                isHarnessCanvas={isHarnessCanvas}
                allowLangflowImport={!isAgentCanvas && !isHarnessCanvas && !isEtlCanvas}
                onOpenFlowiseMigration={() => {
                    setSettingsOpen(false)
                    setMigrationOpen(true)
                }}
            />
            <FlowiseMigrationWizard
                open={migrationOpen}
                onClose={() => setMigrationOpen(false)}
                onOpen={({ canvas, name, route }) => {
                    setMigrationOpen(false)
                    const here = isEtlCanvas
                        ? '/etlcanvas'
                        : isHarnessCanvas
                        ? '/harnesscanvas'
                        : isAgentflowV2
                        ? '/v2/agentcanvas'
                        : isAgentCanvas
                        ? '/agentcanvas'
                        : '/canvas'
                    if (route === here && onApplyMigration) {
                        onApplyMigration({ canvas, name })
                        return
                    }
                    localStorage.setItem('duplicatedFlowData', JSON.stringify({ cuttlelyMigration: true, name, flow: canvas }))
                    navigate(route || '/canvas')
                }}
            />
            <SaveChatflowDialog
                show={flowDialogOpen}
                dialogProps={{
                    title: `Save New ${title}`,
                    placeholder: saveFlowPlaceholder({ isHarnessCanvas }),
                    defaultName: chatflow?.id ? '' : chatflow?.name || '',
                    confirmButtonName: 'Save',
                    cancelButtonName: 'Cancel'
                }}
                onCancel={() => setFlowDialogOpen(false)}
                onConfirm={onConfirmSaveName}
            />
            {versioningEnabled && (
                <VersionHistoryDrawer
                    open={historyOpen}
                    chatflow={chatflow}
                    isDirty={Boolean(canvas.isDirty)}
                    draftMode={showDraftChrome(draftStatus)}
                    onClose={() => setHistoryOpen(false)}
                    onRolledBack={onRolledBack}
                />
            )}
            {apiDialogOpen && <APICodeDialog show={apiDialogOpen} dialogProps={apiDialogProps} onCancel={() => setAPIDialogOpen(false)} />}
            <ViewMessagesDialog
                show={viewMessagesDialogOpen}
                dialogProps={viewMessagesDialogProps}
                onCancel={() => setViewMessagesDialogOpen(false)}
            />
            <ViewLeadsDialog show={viewLeadsDialogOpen} dialogProps={viewLeadsDialogProps} onCancel={() => setViewLeadsDialogOpen(false)} />
            {exportAsTemplateDialogOpen && (
                <ExportAsTemplateDialog
                    show={exportAsTemplateDialogOpen}
                    dialogProps={exportAsTemplateDialogProps}
                    onCancel={() => setExportAsTemplateDialogOpen(false)}
                />
            )}
            <UpsertHistoryDialog
                show={upsertHistoryDialogOpen}
                dialogProps={upsertHistoryDialogProps}
                onCancel={() => setUpsertHistoryDialogOpen(false)}
            />
            <PublishDialog
                open={publishOpen}
                chatflow={chatflow}
                draftStatus={draftStatus}
                isDirty={Boolean(canvas.isDirty)}
                onClose={() => setPublishOpen(false)}
                onDraftStatus={onDraftStatus}
                onChatflowUpdated={onChatflowUpdated}
                onApplyCanvas={onApplyCanvas}
            />
            <ChatflowConfigurationDialog
                key='chatflowConfiguration'
                show={chatflowConfigurationDialogOpen}
                dialogProps={chatflowConfigurationDialogProps}
                onCancel={() => setChatflowConfigurationDialogOpen(false)}
                isAgentCanvas={isAgentCanvas}
            />
        </>
    )
}

CanvasHeader.propTypes = {
    chatflow: PropTypes.object,
    handleSaveFlow: PropTypes.func,
    handleDeleteFlow: PropTypes.func,
    handleLoadFlow: PropTypes.func,
    onApplyMigration: PropTypes.func,
    isAgentCanvas: PropTypes.bool,
    isHarnessCanvas: PropTypes.bool,
    isEtlCanvas: PropTypes.bool,
    isAgentflowV2: PropTypes.bool,
    draftStatus: PropTypes.object,
    onDraftStatus: PropTypes.func,
    onChatflowUpdated: PropTypes.func,
    onApplyCanvas: PropTypes.func
}

export default CanvasHeader
