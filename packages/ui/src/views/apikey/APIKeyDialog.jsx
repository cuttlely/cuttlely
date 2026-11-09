import AccessPolicyEditor, { newAccessPolicy } from './AccessPolicyEditor'
import { accessKeyExamples } from './endpointAccess'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import PropTypes from 'prop-types'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDispatch } from 'react-redux'

import { StyledButton } from '@/ui-component/button/StyledButton'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    OutlinedInput,
    Popover,
    Stack,
    Typography,
    TextField,
    Alert,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Checkbox,
    FormControlLabel,
    MenuItem
} from '@mui/material'
import { useTheme } from '@mui/material/styles'

// Icons
import { IconCopy, IconKey, IconX } from '@tabler/icons-react'

// API
import apikeyApi from '@/api/apikey'
import authApi from '@/api/auth'

// Hooks
import useApi from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/store/context/ConfigContext'

// utils
import useNotifier from '@/utils/useNotifier'

// const
import { HIDE_CANVAS_DIALOG, SHOW_CANVAS_DIALOG } from '@/store/actions'

import './APIKeyDialog.css'

const APIKeyDialog = ({ show, dialogProps, onCancel, onConfirm, setError }) => {
    const portalElement = document.getElementById('portal')

    const theme = useTheme()
    const dispatch = useDispatch()
    const { isOpenSource, isEnterpriseLicensed, isCloud } = useConfig()

    // ==============================|| Snackbar ||============================== //

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [keyName, setKeyName] = useState('')
    const [createdSecret, setCreatedSecret] = useState('')
    const [anchorEl, setAnchorEl] = useState(null)
    const openPopOver = Boolean(anchorEl)
    const [selectedPermissions, setSelectedPermissions] = useState({})
    const [permissions, setPermissions] = useState({})
    const [policy, setPolicy] = useState(newAccessPolicy)
    const [resources, setResources] = useState([])
    const [expiresAt, setExpiresAt] = useState(null)
    const [confirmed, setConfirmed] = useState(false)
    const [options, setOptions] = useState({})
    const [graceSeconds, setGraceSeconds] = useState(3600)
    const [preset, setPreset] = useState('call')
    const [validation, setValidation] = useState(null)
    const [busy, setBusy] = useState(false)
    const [formError, setFormError] = useState('')
    const validationSequence = useRef(0)
    const getAllPermissionsApi = useApi(authApi.getAllPermissions)
    const { hasPermission } = useAuth()
    const canViewChatflows = hasPermission('chatflows:view')
    useEffect(() => {
        const required = new Set()
        if (policy.scopes.some((scope) => ['predict', 'stream', 'upload', 'api:read', 'feedback:read', 'feedback:write'].includes(scope))) {
            if (policy.allResources || !resources.length || resources.some((r) => r.resourceType === 'CHATFLOW'))
                required.add('chatflows:view')
            if (policy.allResources || resources.some((r) => r.resourceType === 'AGENTFLOW')) required.add('agentflows:view')
        }
        if (policy.scopes.some((scope) => scope.startsWith('harness:')))
            required.add(canViewChatflows ? 'chatflows:view' : 'agentflows:view')
        if (!required.size) return
        setSelectedPermissions((current) => {
            const next = { ...current }
            for (const [category, entries] of Object.entries(permissions)) {
                for (const entry of entries) {
                    if (required.has(entry.key)) next[category] = { ...next[category], [entry.key]: true }
                }
            }
            return next
        })
    }, [policy.scopes, policy.allResources, resources, permissions, canViewChatflows])
    const policyBody = () => ({
        accessPolicy: {
            ...policy,
            origins: policy.origins.map((s) => s.trim()).filter(Boolean),
            ips: policy.ips.map((s) => s.trim()).filter(Boolean)
        },
        resources,
        expiresAt,
        confirmAllResources: confirmed
    })
    const permissionList = () => [
        ...new Set(Object.values(selectedPermissions).flatMap((group) => Object.keys(group).filter((key) => group[key])))
    ]
    const applySuggestion = (suggested) => {
        setPolicy(suggested.accessPolicy)
        setResources(suggested.resources)
        const grouped = {}
        for (const [category, entries] of Object.entries(permissions)) {
            grouped[category] = Object.fromEntries(
                entries.filter((entry) => suggested.permissions.includes(entry.key)).map((entry) => [entry.key, true])
            )
        }
        setSelectedPermissions(grouped)
        setValidation(null)
    }
    const selectPresetFlows = async (selected, nextPreset = preset) => {
        const sequence = ++validationSequence.current
        setResources(selected)
        setValidation(null)
        setFormError('')
        const nextPolicy = { ...policy, allResources: false, scopes: [nextPreset === 'read' ? 'api:read' : 'predict'] }
        setPolicy(nextPolicy)
        setConfirmed(false)
        if (!selected.length) {
            setBusy(false)
            return
        }
        const first = options.resources?.find((r) => r.resourceId === selected[0].resourceId)
        const suggestedName = keyName || `${nextPreset === 'read' ? 'Read' : 'Call'} ${first?.name || 'my flow'}`
        if (!keyName) setKeyName(suggestedName)
        setBusy(true)
        try {
            const result = await apikeyApi.validate({
                keyName: suggestedName,
                permissions: [],
                ...policyBody(),
                accessPolicy: nextPolicy,
                resources: selected
            })
            if (sequence !== validationSequence.current) return
            if (result.data.canFix) applySuggestion(result.data.suggested)
            else setValidation(result.data)
        } catch (error) {
            if (sequence === validationSequence.current)
                setFormError(error.response?.data?.message || 'The selected flow could not be checked. Try again.')
        } finally {
            if (sequence === validationSequence.current) setBusy(false)
        }
    }
    const validateBeforeSave = async (body) => {
        const result = await apikeyApi.validate(body)
        setValidation(result.data.valid ? null : result.data)
        return result.data.valid
    }
    const rotate = async () => {
        try {
            const result = await apikeyApi.rotate(dialogProps.key.id, graceSeconds)
            setCreatedSecret(result.data.apiKey)
        } catch (error) {
            if (setError) setError(error)
        }
    }
    const revokeCredential = async (credentialId) => {
        try {
            await apikeyApi.revokeCredential(dialogProps.key.id, credentialId)
            onConfirm()
        } catch (error) {
            if (setError) setError(error)
        }
    }

    useEffect(() => {
        if (dialogProps.type === 'EDIT' && dialogProps.key) {
            setKeyName(dialogProps.key.keyName)
            setPolicy(dialogProps.key.accessPolicy || newAccessPolicy())
            setResources(dialogProps.key.resources || [])
            setExpiresAt(dialogProps.key.expiresAt || null)
        } else if (dialogProps.type === 'ADD') {
            setKeyName('')
            setPolicy(newAccessPolicy())
            setResources([])
            setExpiresAt(new Date(Date.now() + 90 * 86400000).toISOString())
        }
        getAllPermissionsApi.request('API_KEY')
        setConfirmed(false)
        setPreset('call')
        setValidation(null)
        setFormError('')
        setBusy(false)
        validationSequence.current += 1
        apikeyApi
            .options()
            .then((r) => setOptions(r.data))
            .catch((error) => {
                if (setError) setError(error)
            })
        setCreatedSecret('')
        return () => {
            setSelectedPermissions({})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dialogProps])

    useEffect(() => {
        if (getAllPermissionsApi.error) {
            if (setError) setError(getAllPermissionsApi.error)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllPermissionsApi.error])

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    useEffect(() => {
        if (getAllPermissionsApi.data) {
            const permissionsData = getAllPermissionsApi.data

            // Filter permissions based on current platform
            Object.keys(permissionsData).forEach((category) => {
                permissionsData[category] = permissionsData[category].filter((permission) => {
                    if (isOpenSource) return permission.isOpenSource
                    if (isEnterpriseLicensed) return permission.isEnterprise
                    if (isCloud) return permission.isCloud
                    return false
                })
            })

            // Remove categories that have no permissions left
            Object.keys(permissionsData).forEach((category) => {
                if (permissionsData[category].length === 0) {
                    delete permissionsData[category]
                }
            })

            setPermissions(permissionsData)

            if (dialogProps.type === 'EDIT' && dialogProps.key) {
                const keyPermissions = dialogProps.key.permissions || []
                if (keyPermissions && keyPermissions.length > 0) {
                    const tempSelectedPermissions = {}
                    Object.keys(permissionsData).forEach((category) => {
                        permissionsData[category].forEach((permission) => {
                            keyPermissions.forEach((perm) => {
                                if (perm === permission.key) {
                                    if (!tempSelectedPermissions[category]) {
                                        tempSelectedPermissions[category] = {}
                                    }
                                    tempSelectedPermissions[category][perm] = true
                                }
                            })
                        })
                    })
                    setSelectedPermissions(tempSelectedPermissions)
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllPermissionsApi.data])

    const handleClosePopOver = () => {
        setAnchorEl(null)
    }

    const handlePermissionChange = (category, key) => {
        setSelectedPermissions((prevPermissions) => {
            const updatedCategoryPermissions = {
                ...prevPermissions[category],
                [key]: !prevPermissions[category]?.[key]
            }

            if (category === 'templates') {
                if (key !== 'templates:marketplace' && key !== 'templates:custom') {
                    updatedCategoryPermissions['templates:marketplace'] = true
                    updatedCategoryPermissions['templates:custom'] = true
                }
            } else {
                const viewPermissionKey = `${category}:view`
                if (key !== viewPermissionKey) {
                    const hasEnabledPermissions = Object.entries(updatedCategoryPermissions).some(
                        ([permissionKey, isEnabled]) => permissionKey !== viewPermissionKey && isEnabled
                    )
                    if (hasEnabledPermissions) {
                        updatedCategoryPermissions[viewPermissionKey] = true
                    }
                } else {
                    const hasEnabledPermissions = Object.entries(updatedCategoryPermissions).some(
                        ([permissionKey, isEnabled]) => permissionKey === viewPermissionKey && isEnabled
                    )
                    if (hasEnabledPermissions) {
                        updatedCategoryPermissions[key] = true
                    }
                }
            }

            return {
                ...prevPermissions,
                [category]: updatedCategoryPermissions
            }
        })
    }

    const isCheckboxDisabled = (permissions, category, key) => {
        if (category === 'templates') {
            // For templates, disable marketplace and custom view if any other permission is enabled
            if (key === 'templates:marketplace' || key === 'templates:custom') {
                return Object.entries(permissions[category] || {}).some(
                    ([permKey, isEnabled]) => permKey !== 'templates:marketplace' && permKey !== 'templates:custom' && isEnabled
                )
            }
        } else {
            const viewPermissionKey = `${category}:view`
            if (key === viewPermissionKey) {
                // Disable the view permission if any other permission is enabled
                return Object.entries(permissions[category] || {}).some(
                    ([permKey, isEnabled]) => permKey !== viewPermissionKey && isEnabled
                )
            }
        }

        // Non-view permissions are never disabled
        return false
    }

    const handleSelectAll = (category) => {
        const allSelected = permissions[category].every((permission) => selectedPermissions[category]?.[permission.key])
        setSelectedPermissions((prevPermissions) => ({
            ...prevPermissions,
            [category]: Object.fromEntries(permissions[category].map((permission) => [permission.key, !allSelected]))
        }))
    }

    const addNewKey = async () => {
        if (busy) return
        setBusy(true)
        setFormError('')
        try {
            const tempPermissions = permissionList()

            const body = {
                keyName,
                permissions: [...new Set(tempPermissions)],
                ...policyBody()
            }
            if (!(await validateBeforeSave(body))) return
            const createResp = await apikeyApi.createNewAPI(body)
            if (createResp.data) {
                const rows = Array.isArray(createResp.data) ? createResp.data : createResp.data.data || []
                const revealed = rows.find((row) => row && row.apiKey)
                enqueueSnackbar({
                    message: 'New access key added',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'success',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                if (revealed && revealed.apiKey) {
                    setCreatedSecret(revealed.apiKey)
                    return
                }
                onConfirm()
            }
        } catch (error) {
            setFormError(error.response?.data?.message || 'The key could not be created. Check the selected flow and try again.')
            enqueueSnackbar({
                message: `Failed to add new API key: ${error.response?.data?.message || 'Check the selected flow and try again.'}`,
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
        } finally {
            setBusy(false)
        }
    }

    const saveKey = async () => {
        if (busy) return
        setBusy(true)
        setFormError('')
        try {
            const tempPermissions = permissionList()

            const body = {
                keyName,
                permissions: [...new Set(tempPermissions)],
                ...policyBody()
            }
            if (!(await validateBeforeSave(body))) return
            const saveResp = await apikeyApi.updateAPI(dialogProps.key.id, body)
            if (saveResp.data) {
                enqueueSnackbar({
                    message: 'Access key saved',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'success',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                onConfirm()
            }
        } catch (error) {
            setFormError(error.response?.data?.message || 'The key could not be saved. Review its access and try again.')
            enqueueSnackbar({
                message: `Failed to save API key: ${error.response?.data?.message || 'Review its access and try again.'}`,
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
        } finally {
            setBusy(false)
        }
    }

    const checkDisabled = () => {
        if (busy || (dialogProps.type === 'ADD' && (!policy.scopes.length || (!resources.length && !policy.allResources)))) return true
        if (!keyName || keyName === '') {
            return true
        }
        if (options.rollout !== 'on') return true
        if (policy.allResources && !confirmed) return true
        return false
    }
    const exampleFlow = resources.find((r) => ['CHATFLOW', 'AGENTFLOW'].includes(r.resourceType))
    const examples = exampleFlow ? accessKeyExamples(window.location.origin, exampleFlow, !policy.scopes.includes('predict')) : null

    const component = show ? (
        <Dialog
            fullWidth
            maxWidth='md'
            open={show}
            onClose={createdSecret ? () => {} : onCancel}
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <IconKey style={{ marginRight: '10px' }} />
                    {dialogProps.title}
                </div>
            </DialogTitle>
            <DialogContent sx={{ backgroundColor: 'transparent' }}>
                {formError && (
                    <Alert severity='error'>
                        {formError} <a href='https://cuttlely.com/docs/how-to/access-keys/'>Access-key help</a>
                    </Alert>
                )}
                {validation && (
                    <Alert severity='warning'>
                        {validation.missing.map((message) => (
                            <Typography key={message}>{message}</Typography>
                        ))}
                        {validation.canFix && <Button onClick={() => applySuggestion(validation.suggested)}>Add missing access</Button>}
                    </Alert>
                )}
                {createdSecret && (
                    <Box sx={{ p: 2 }}>
                        <Typography sx={{ mb: 1 }}>Copy this key now. Cuttlely stores only a hash, so it cannot be shown again.</Typography>
                        <Stack direction='row' sx={{ mb: 1 }}>
                            <Typography
                                sx={{
                                    p: 1,
                                    borderRadius: 10,
                                    backgroundColor: theme.palette.primary.light,
                                    width: 'max-content',
                                    height: 'max-content',
                                    wordBreak: 'break-all'
                                }}
                                variant='h5'
                            >
                                {createdSecret}
                            </Typography>
                            <IconButton
                                title='Copy API Key'
                                color='success'
                                onClick={(event) => {
                                    navigator.clipboard.writeText(createdSecret)
                                    setAnchorEl(event.currentTarget)
                                    setTimeout(() => {
                                        handleClosePopOver()
                                    }, 1500)
                                }}
                            >
                                <IconCopy />
                            </IconButton>
                            <Popover
                                open={openPopOver}
                                anchorEl={anchorEl}
                                onClose={handleClosePopOver}
                                anchorOrigin={{
                                    vertical: 'top',
                                    horizontal: 'right'
                                }}
                                transformOrigin={{
                                    vertical: 'top',
                                    horizontal: 'left'
                                }}
                            >
                                <Typography variant='h6' sx={{ pl: 1, pr: 1, color: 'white', background: theme.palette.success.dark }}>
                                    Copied!
                                </Typography>
                            </Popover>
                        </Stack>
                        {examples && (
                            <>
                                <Typography>
                                    On your server, set CUTTLELY_API_KEY to the secret above. Then call the selected flow:
                                </Typography>
                                {Object.entries(examples).map(([language, code]) => (
                                    <Box key={language} sx={{ mt: 2 }}>
                                        <Typography variant='h5'>{language === 'curl' ? 'cURL' : 'JavaScript (server)'}</Typography>
                                        <Box
                                            component='pre'
                                            sx={{ overflow: 'auto', p: 1, backgroundColor: theme.palette.background.default }}
                                        >
                                            <code>{code}</code>
                                        </Box>
                                        <Button onClick={() => navigator.clipboard.writeText(code)}>
                                            Copy {language === 'curl' ? 'cURL' : 'JavaScript'}
                                        </Button>
                                    </Box>
                                ))}
                            </>
                        )}
                    </Box>
                )}
                {dialogProps.type === 'EDIT' && !createdSecret && (
                    <Box sx={{ p: 2 }}>
                        <Typography variant='overline'>API Key</Typography>
                        {dialogProps.key?.apiKey ? (
                            <Stack direction='row' sx={{ mb: 1 }}>
                                <Typography
                                    sx={{
                                        p: 1,
                                        borderRadius: 10,
                                        backgroundColor: theme.palette.primary.light,
                                        width: 'max-content',
                                        height: 'max-content'
                                    }}
                                    variant='h5'
                                >
                                    {dialogProps.key.apiKey}
                                </Typography>
                                <IconButton
                                    title='Copy API Key'
                                    color='success'
                                    onClick={(event) => {
                                        navigator.clipboard.writeText(dialogProps.key.apiKey)
                                        setAnchorEl(event.currentTarget)
                                        setTimeout(() => {
                                            handleClosePopOver()
                                        }, 1500)
                                    }}
                                >
                                    <IconCopy />
                                </IconButton>
                                <Popover
                                    open={openPopOver}
                                    anchorEl={anchorEl}
                                    onClose={handleClosePopOver}
                                    anchorOrigin={{
                                        vertical: 'top',
                                        horizontal: 'right'
                                    }}
                                    transformOrigin={{
                                        vertical: 'top',
                                        horizontal: 'left'
                                    }}
                                >
                                    <Typography variant='h6' sx={{ pl: 1, pr: 1, color: 'white', background: theme.palette.success.dark }}>
                                        Copied!
                                    </Typography>
                                </Popover>
                            </Stack>
                        ) : (
                            <Typography sx={{ mt: 1 }}>This key is stored as a hash and cannot be shown again.</Typography>
                        )}
                    </Box>
                )}

                {!createdSecret && (
                    <div className='apikey-editor'>
                        {dialogProps.type === 'ADD' && (
                            <Box>
                                <Typography variant='h5'>Start with a preset</Typography>
                                <TextField
                                    select
                                    fullWidth
                                    label='What will this key do?'
                                    value={preset}
                                    onChange={(event) => {
                                        const next = event.target.value
                                        setPreset(next)
                                        void selectPresetFlows(
                                            resources.filter((r) => ['CHATFLOW', 'AGENTFLOW'].includes(r.resourceType)),
                                            next
                                        )
                                    }}
                                >
                                    <MenuItem value='call'>Call one chatflow/agentflow</MenuItem>
                                    <MenuItem value='read'>Read-only API</MenuItem>
                                </TextField>
                                <Typography sx={{ mt: 1 }}>
                                    {preset === 'call'
                                        ? 'Pick the flows your app will call. Required view permission and referenced Harness access are included automatically.'
                                        : 'Pick resources to read through the API. This preset cannot run or edit them.'}
                                </Typography>
                                {(options.resources || [])
                                    .filter((r) =>
                                        ['CHATFLOW', 'AGENTFLOW', ...(preset === 'read' ? ['HARNESS'] : [])].includes(r.resourceType)
                                    )
                                    .map((resource) => (
                                        <FormControlLabel
                                            key={resource.resourceType + ':' + resource.resourceId}
                                            label={resource.name}
                                            control={
                                                <Checkbox
                                                    checked={resources.some(
                                                        (r) =>
                                                            r.resourceType === resource.resourceType && r.resourceId === resource.resourceId
                                                    )}
                                                    onChange={(event) => {
                                                        const selected = resources.filter(
                                                            (r) =>
                                                                (preset === 'read' || r.resourceType !== 'HARNESS') &&
                                                                !(
                                                                    r.resourceType === resource.resourceType &&
                                                                    r.resourceId === resource.resourceId
                                                                )
                                                        )
                                                        if (event.target.checked)
                                                            selected.push({
                                                                resourceType: resource.resourceType,
                                                                resourceId: resource.resourceId
                                                            })
                                                        void selectPresetFlows(selected)
                                                    }}
                                                />
                                            }
                                        />
                                    ))}
                                {options.resources &&
                                    !options.resources.some((r) => ['CHATFLOW', 'AGENTFLOW'].includes(r.resourceType)) && (
                                        <Alert severity='info'>
                                            Create a chatflow or agentflow first, or ask your admin for view access. Then return here to
                                            create its key.
                                        </Alert>
                                    )}
                                {resources.some((r) => r.resourceType === 'HARNESS') && (
                                    <Typography>
                                        Included Harnesses:{' '}
                                        {resources
                                            .filter((r) => r.resourceType === 'HARNESS')
                                            .map(
                                                (r) =>
                                                    options.resources?.find(
                                                        (choice) => choice.resourceType === 'HARNESS' && choice.resourceId === r.resourceId
                                                    )?.name || 'Unavailable Harness'
                                            )
                                            .join(', ')}
                                    </Typography>
                                )}
                                {busy && <Typography role='status'>Checking this key’s access…</Typography>}
                            </Box>
                        )}
                        <Box>
                            <Typography sx={{ mb: 1 }} variant='h5'>
                                <span style={{ color: 'red' }}>*&nbsp;&nbsp;</span>Key Name
                            </Typography>
                            <OutlinedInput
                                id='keyName'
                                type='string'
                                size='small'
                                fullWidth
                                placeholder='My New Key'
                                value={keyName}
                                name='keyName'
                                onChange={(e) => setKeyName(e.target.value)}
                            />
                        </Box>
                        <Accordion defaultExpanded={dialogProps.type === 'EDIT'} sx={{ mt: 2 }}>
                            <AccordionSummary>Advanced: permissions, API operations and resources</AccordionSummary>
                            <AccordionDetails>
                                <div className='permissions-container'>
                                    <p>
                                        <span style={{ color: 'red' }}>*&nbsp;&nbsp;</span>Permissions
                                    </p>
                                    <div className='permissions-list-wrapper'>
                                        <div className='permission-category'>
                                            <h3>HARNESS</h3>
                                            <p>Run granted teams with view permission. Editing a team still needs edit permission.</p>
                                            {Object.entries(permissions).flatMap(([category, entries]) =>
                                                entries
                                                    .filter((entry) => entry.key === 'chatflows:view')
                                                    .map((entry) => (
                                                        <label key='harness-view'>
                                                            <input
                                                                type='checkbox'
                                                                checked={selectedPermissions[category]?.[entry.key] || false}
                                                                onChange={() => handlePermissionChange(category, entry.key)}
                                                            />
                                                            Run/view granted Harnesses (chatflows:view)
                                                        </label>
                                                    ))
                                            )}
                                        </div>
                                        {permissions &&
                                            Object.keys(permissions).map((category) => (
                                                <div key={category} className='permission-category'>
                                                    <div className='category-header'>
                                                        <h3>
                                                            {category
                                                                .replace(/([A-Z])/g, ' $1')
                                                                .trim()
                                                                .toUpperCase()}
                                                        </h3>
                                                        <button type='button' onClick={() => handleSelectAll(category)}>
                                                            Select All
                                                        </button>
                                                    </div>
                                                    <div className='permissions-list'>
                                                        {permissions[category].map((permission, index) => (
                                                            <div
                                                                key={permission.key}
                                                                className={`permission-item ${
                                                                    index % 2 === 0 ? 'left-column' : 'right-column'
                                                                }`}
                                                            >
                                                                <label>
                                                                    <input
                                                                        type='checkbox'
                                                                        checked={selectedPermissions[category]?.[permission.key] || false}
                                                                        disabled={isCheckboxDisabled(
                                                                            selectedPermissions,
                                                                            category,
                                                                            permission.key
                                                                        )}
                                                                        onChange={() => handlePermissionChange(category, permission.key)}
                                                                    />
                                                                    {permission.value}
                                                                </label>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                                <AccessPolicyEditor
                                    policy={policy}
                                    setPolicy={setPolicy}
                                    resources={resources}
                                    setResources={setResources}
                                    options={options}
                                    expiresAt={expiresAt}
                                    setExpiresAt={setExpiresAt}
                                    confirmed={confirmed}
                                    setConfirmed={setConfirmed}
                                />
                            </AccordionDetails>
                        </Accordion>
                        {dialogProps.type === 'EDIT' && (
                            <Box sx={{ mt: 3 }}>
                                <Typography variant='h5'>Credentials and usage</Typography>
                                <Typography variant='body2'>
                                    Rotation preserves this principal and its policy. Revocation blocks new work; admitted runs may finish.
                                </Typography>
                                <TextField
                                    label='Rotation grace (seconds, 0–86400)'
                                    type='number'
                                    value={graceSeconds}
                                    onChange={(e) => setGraceSeconds(Number(e.target.value))}
                                    inputProps={{ min: 0, max: 86400 }}
                                />
                                {hasPermission('apikeys:update') && (
                                    <Button onClick={rotate} disabled={!!dialogProps.key.disabledAt || options.rollout !== 'on'}>
                                        Rotate and reveal successor once
                                    </Button>
                                )}
                                {dialogProps.key.hasLegacyCredential && (
                                    <Button onClick={() => revokeCredential('legacy')}>Revoke legacy credential</Button>
                                )}
                                {(dialogProps.key.credentials || []).map((credential) => (
                                    <Stack direction='row' key={credential.id} spacing={1}>
                                        <Typography>
                                            {credential.displayPrefix}…{credential.lastFour} ·{' '}
                                            {credential.revokedAt
                                                ? 'Revoked'
                                                : credential.expiresAt
                                                ? `Expires ${credential.expiresAt}`
                                                : 'No expiry'}
                                        </Typography>
                                        <Button disabled={!!credential.revokedAt} onClick={() => revokeCredential(credential.id)}>
                                            Revoke credential
                                        </Button>
                                    </Stack>
                                ))}
                                {(dialogProps.key.usage || [])
                                    .filter((u) => u.operation === '*')
                                    .map((u) => (
                                        <Typography key={u.period}>
                                            {u.period} UTC: {u.accepted} accepted; last used {u.lastUsedAt || 'Never'}
                                        </Typography>
                                    ))}
                            </Box>
                        )}
                    </div>
                )}
            </DialogContent>
            <DialogActions>
                {createdSecret ? (
                    <StyledButton
                        variant='contained'
                        onClick={() => {
                            setCreatedSecret('')
                            onConfirm()
                        }}
                    >
                        Done
                    </StyledButton>
                ) : (
                    <>
                        <Button variant='outlined' onClick={onCancel}>
                            Cancel
                        </Button>
                        <StyledButton
                            disabled={checkDisabled()}
                            variant='contained'
                            onClick={() => (dialogProps.type === 'ADD' ? addNewKey() : saveKey())}
                            id={dialogProps.customBtnId}
                        >
                            {dialogProps.confirmButtonName}
                        </StyledButton>
                    </>
                )}
            </DialogActions>
            <ConfirmDialog />
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

APIKeyDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func,
    setError: PropTypes.func
}

export default APIKeyDialog
