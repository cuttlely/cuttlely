import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link } from 'react-router-dom'

import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Box,
    Typography,
    OutlinedInput,
    MenuItem,
    Alert,
    Select
} from '@mui/material'

import { StyledButton } from '@/ui-component/button/StyledButton'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import { IconX, IconUserPlus } from '@tabler/icons-react'

import accountApi from '@/api/account.api'
import { isBuiltInOwnerRole, roleLabel } from '@/utils/roleLabel'
import roleApi from '@/api/role'
import workspaceApi from '@/api/workspace'
import useNotifier from '@/utils/useNotifier'
import {
    enqueueSnackbar as enqueueSnackbarAction,
    closeSnackbar as closeSnackbarAction,
    HIDE_CANVAS_DIALOG,
    SHOW_CANVAS_DIALOG
} from '@/store/actions'

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

const CreateUserDialog = ({ show, workspace, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')
    const dispatch = useDispatch()
    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))
    const currentUser = useSelector((state) => state.auth.user)

    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [teams, setTeams] = useState([])
    const [roles, setRoles] = useState([])
    const [teamId, setTeamId] = useState(workspace?.id || '')
    const [roleId, setRoleId] = useState('')
    const [loadingChoices, setLoadingChoices] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [formError, setFormError] = useState('')

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    useEffect(() => {
        if (!show) return
        let cancelled = false
        setName('')
        setEmail('')
        setFormError('')
        setTeamId(workspace?.id || '')
        setRoleId('')
        setLoadingChoices(true)
        Promise.all([
            workspaceApi.getAllWorkspacesByOrganizationId(currentUser.activeOrganizationId),
            roleApi.getAllRolesByOrganizationId(currentUser.activeOrganizationId)
        ])
            .then(([workspaceResponse, roleResponse]) => {
                if (cancelled) return
                const nextTeams = (workspaceResponse.data || []).filter((item) => item.name !== 'Personal Workspace')
                const nextRoles = (roleResponse.data || []).filter((item) => !isBuiltInOwnerRole(item))
                setTeams(nextTeams)
                setRoles(nextRoles)
                setTeamId((current) => current || (nextTeams.length === 1 ? nextTeams[0].id : ''))
                setRoleId(nextRoles.length === 1 ? nextRoles[0].id : '')
            })
            .catch((error) => {
                if (cancelled) return
                setFormError(error.response?.data?.message || error.message || 'Could not load teams and roles')
            })
            .finally(() => {
                if (!cancelled) setLoadingChoices(false)
            })
        return () => {
            cancelled = true
        }
    }, [show, workspace?.id, currentUser.activeOrganizationId])

    const canSubmit =
        !isSaving &&
        !loadingChoices &&
        name.trim().length > 0 &&
        name.trim().length <= 100 &&
        EMAIL_PATTERN.test(email.trim()) &&
        teamId &&
        roleId

    const saveUser = async () => {
        const problem = !name.trim()
            ? 'Name is required.'
            : !EMAIL_PATTERN.test(email.trim())
            ? 'Enter a valid email.'
            : !teamId
            ? 'Choose a team.'
            : !roleId
            ? 'Choose a role. Create one on the Roles page first.'
            : ''
        if (problem) {
            setFormError(problem)
            return
        }
        setFormError('')
        setIsSaving(true)
        try {
            await accountApi.inviteAccount({
                user: {
                    name: name.trim(),
                    email: email.trim(),
                    createdBy: currentUser.id
                },
                workspace: { id: teamId },
                role: { id: roleId }
            })
            enqueueSnackbar({
                message: 'User created',
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
        } catch (error) {
            const message = error.response?.data?.message || error.message || 'Could not create the user'
            setFormError(message)
            enqueueSnackbar({
                message,
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
            setIsSaving(false)
        }
    }

    const component = show ? (
        <Dialog fullWidth maxWidth='sm' open={show} onClose={onCancel} aria-labelledby='create-user-title'>
            <DialogTitle sx={{ fontSize: '1rem' }} id='create-user-title'>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <IconUserPlus style={{ marginRight: '10px' }} />
                    Add User
                </div>
            </DialogTitle>
            <DialogContent>
                {roles.length === 0 && !loadingChoices && (
                    <Alert severity='info' sx={{ mb: 2 }}>
                        Create a role on the{' '}
                        <Link to='/roles' onClick={onCancel}>
                            Roles
                        </Link>{' '}
                        page before adding a user. The role is where you set what they can do.
                    </Alert>
                )}
                {formError && (
                    <Alert severity='error' sx={{ mb: 2 }}>
                        {formError}
                    </Alert>
                )}
                <Box sx={{ p: 1 }}>
                    <Typography>
                        Name<span style={{ color: 'red' }}>&nbsp;*</span>
                    </Typography>
                    <OutlinedInput
                        id='user-name'
                        size='small'
                        sx={{ mt: 1 }}
                        fullWidth
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Box>
                <Box sx={{ p: 1 }}>
                    <Typography>
                        Email<span style={{ color: 'red' }}>&nbsp;*</span>
                    </Typography>
                    <OutlinedInput
                        id='user-email'
                        size='small'
                        sx={{ mt: 1 }}
                        type='email'
                        fullWidth
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                </Box>
                <Box sx={{ p: 1 }}>
                    <Typography variant='caption' color='text.secondary'>
                        They sign in with WorkOS. No password is stored here.
                    </Typography>
                </Box>
                <Box sx={{ p: 1 }}>
                    <Typography>
                        Team<span style={{ color: 'red' }}>&nbsp;*</span>
                    </Typography>
                    <Select
                        id='user-team'
                        size='small'
                        sx={{ mt: 1 }}
                        fullWidth
                        value={teamId}
                        displayEmpty
                        disabled={Boolean(workspace?.id)}
                        onChange={(event) => setTeamId(event.target.value)}
                        input={<OutlinedInput />}
                    >
                        <MenuItem value='' disabled>
                            Choose a team
                        </MenuItem>
                        {teams.map((team) => (
                            <MenuItem key={team.id} value={team.id}>
                                {team.name}
                            </MenuItem>
                        ))}
                    </Select>
                </Box>
                <Box sx={{ p: 1 }}>
                    <Typography>
                        Role<span style={{ color: 'red' }}>&nbsp;*</span>
                    </Typography>
                    <Select
                        id='user-role'
                        size='small'
                        sx={{ mt: 1 }}
                        fullWidth
                        value={roleId}
                        displayEmpty
                        onChange={(event) => setRoleId(event.target.value)}
                        input={<OutlinedInput />}
                    >
                        <MenuItem value='' disabled>
                            Choose a role
                        </MenuItem>
                        {roles.map((role) => (
                            <MenuItem key={role.id} value={role.id}>
                                {roleLabel(role)}
                            </MenuItem>
                        ))}
                    </Select>
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>Cancel</Button>
                <StyledButton id='btn_submit_user' disabled={!canSubmit} variant='contained' onClick={saveUser}>
                    {isSaving ? 'Creating...' : 'Create User'}
                </StyledButton>
            </DialogActions>
            <ConfirmDialog />
        </Dialog>
    ) : null

    return portalElement ? createPortal(component, portalElement) : null
}

CreateUserDialog.propTypes = {
    show: PropTypes.bool,
    workspace: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default CreateUserDialog
