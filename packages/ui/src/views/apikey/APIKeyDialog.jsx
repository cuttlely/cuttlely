import AccessPolicyEditor, { newAccessPolicy } from './AccessPolicyEditor'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
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
    TextField
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
    const getAllPermissionsApi = useApi(authApi.getAllPermissions)
    const { hasPermission } = useAuth()
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
        try {
            const tempPermissions = Object.keys(selectedPermissions)
                .map((category) => {
                    return Object.keys(selectedPermissions[category]).map((key) => {
                        if (selectedPermissions[category][key]) {
                            return key
                        }
                    })
                })
                .flat()
                .filter(Boolean)

            const createResp = await apikeyApi.createNewAPI({
                keyName,
                permissions: tempPermissions,
                ...policyBody()
            })
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
            if (setError) setError(error)
            enqueueSnackbar({
                message: `Failed to add new API key: ${
                    typeof error.response.data === 'object' ? error.response.data.message : error.response.data
                }`,
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
            onCancel()
        }
    }

    const saveKey = async () => {
        try {
            const tempPermissions = Object.keys(selectedPermissions)
                .map((category) => {
                    return Object.keys(selectedPermissions[category]).map((key) => {
                        if (selectedPermissions[category][key]) {
                            return key
                        }
                    })
                })
                .flat()
                .filter(Boolean)

            const saveResp = await apikeyApi.updateAPI(dialogProps.key.id, {
                keyName,
                permissions: tempPermissions,
                ...policyBody()
            })
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
            if (setError) setError(error)
            enqueueSnackbar({
                message: `Failed to save API key: ${
                    typeof error.response.data === 'object' ? error.response.data.message : error.response.data
                }`,
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
            onCancel()
        }
    }

    const checkDisabled = () => {
        if (!keyName || keyName === '') {
            return true
        }
        if (options.rollout !== 'on') return true
        if (policy.allResources && !confirmed) return true
        return false
    }

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
                        <div className='permissions-container'>
                            <p>
                                <span style={{ color: 'red' }}>*&nbsp;&nbsp;</span>Permissions
                            </p>
                            <div className='permissions-list-wrapper'>
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
                                                        className={`permission-item ${index % 2 === 0 ? 'left-column' : 'right-column'}`}
                                                    >
                                                        <label>
                                                            <input
                                                                type='checkbox'
                                                                checked={selectedPermissions[category]?.[permission.key] || false}
                                                                disabled={isCheckboxDisabled(selectedPermissions, category, permission.key)}
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
