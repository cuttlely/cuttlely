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
    Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'

// Icons
import { IconCopy, IconKey, IconX } from '@tabler/icons-react'

// API
import apikeyApi from '@/api/apikey'
import authApi from '@/api/auth'
import harnessesApi from '@/api/harnesses'

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
    const [selectedHarnesses, setSelectedHarnesses] = useState([])

    const getAllPermissionsApi = useApi(authApi.getAllPermissions)
    const listHarnessesApi = useApi(harnessesApi.listHarnesses)
    const { hasPermission } = useAuth()
    const canListHarnesses = hasPermission('chatflows:view,agentflows:view')
    const harnessNames = Array.isArray(listHarnessesApi.data) ? listHarnessesApi.data.map((row) => row.name).sort() : []

    useEffect(() => {
        if (dialogProps.type === 'EDIT' && dialogProps.key) {
            setKeyName(dialogProps.key.keyName)
            setSelectedHarnesses(Array.isArray(dialogProps.key.harnesses) ? dialogProps.key.harnesses : [])
        } else if (dialogProps.type === 'ADD') {
            setKeyName('')
            setSelectedHarnesses([])
        }
        getAllPermissionsApi.request('API_KEY')
        if (canListHarnesses) listHarnessesApi.request()
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
                harnesses: selectedHarnesses
            })
            if (createResp.data) {
                const rows = Array.isArray(createResp.data) ? createResp.data : createResp.data.data || []
                const revealed = rows.find((row) => row && row.apiKey)
                enqueueSnackbar({
                    message: 'New API key added',
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
                harnesses: selectedHarnesses
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: 'API Key saved',
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
        if (!Object.keys(selectedPermissions).length || !ifPermissionContainsTrue(selectedPermissions)) {
            return true
        }
        return false
    }

    const ifPermissionContainsTrue = (obj) => {
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                // Recursively check nested objects
                if (ifPermissionContainsTrue(obj[key])) {
                    return true
                }
            } else if (obj[key] === true) {
                return true
            }
        }
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
                        <div className='permissions-container'>
                            <p>Harnesses this key may run</p>
                            <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                                A key runs no harness until one is ticked here. It also needs a chatflow create or update permission to
                                start a run, and chatflow view to read runs.
                            </Typography>
                            {!canListHarnesses ? (
                                <Typography variant='body2' color='text.secondary'>
                                    You need chatflow view permission to choose harnesses.
                                </Typography>
                            ) : listHarnessesApi.error ? (
                                <Typography variant='body2' color='error'>
                                    Could not load the harnesses in this team.
                                </Typography>
                            ) : harnessNames.length === 0 && !listHarnessesApi.loading ? (
                                <Typography variant='body2' color='text.secondary'>
                                    This team has no harnesses yet.
                                </Typography>
                            ) : (
                                <div className='permissions-list'>
                                    {[...new Set([...harnessNames, ...selectedHarnesses])].map((harnessName, index) => (
                                        <div
                                            key={harnessName}
                                            className={`permission-item ${index % 2 === 0 ? 'left-column' : 'right-column'}`}
                                        >
                                            <label>
                                                <input
                                                    type='checkbox'
                                                    checked={selectedHarnesses.includes(harnessName)}
                                                    onChange={() =>
                                                        setSelectedHarnesses((current) =>
                                                            current.includes(harnessName)
                                                                ? current.filter((item) => item !== harnessName)
                                                                : [...current, harnessName]
                                                        )
                                                    }
                                                />
                                                {harnessName}
                                            </label>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
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
