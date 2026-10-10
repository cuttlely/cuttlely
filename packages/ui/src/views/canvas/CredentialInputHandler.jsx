import PropTypes from 'prop-types'
import { useEffect, useRef, useState } from 'react'

// material-ui
import { IconButton } from '@mui/material'
import { IconEdit } from '@tabler/icons-react'

// project import
import { AsyncDropdown } from '@/ui-component/dropdown/AsyncDropdown'
import AddEditCredentialDialog from '@/views/credentials/AddEditCredentialDialog'
import CredentialListDialog from '@/views/credentials/CredentialListDialog'

// API
import credentialsApi from '@/api/credentials'
import nodesApi from '@/api/nodes'
import { useAuth } from '@/hooks/useAuth'
import { FLOWISE_CREDENTIAL_ID } from '@/store/constant'
import { postgresCredentialHint } from '@/utils/postgresCredentialHint'
import { onlyFit } from '@/utils/yourKey'

// ===========================|| CredentialInputHandler ||=========================== //

const CredentialInputHandler = ({ inputParam, data, onSelect, onHint, disabled = false, pickOnlyFit = false }) => {
    const ref = useRef(null)
    const [credentialId, setCredentialId] = useState(data?.credential || (data?.inputs && data.inputs[FLOWISE_CREDENTIAL_ID]) || '')
    const [showCredentialListDialog, setShowCredentialListDialog] = useState(false)
    const [credentialListDialogProps, setCredentialListDialogProps] = useState({})
    const [showSpecificCredentialDialog, setShowSpecificCredentialDialog] = useState(false)
    const [specificCredentialDialogProps, setSpecificCredentialDialogProps] = useState({})
    const [reloadTimestamp, setReloadTimestamp] = useState(Date.now().toString())
    const [credentialHint, setCredentialHint] = useState('')
    const { hasPermission } = useAuth()

    const editCredential = (credentialId) => {
        const dialogProp = {
            type: 'EDIT',
            cancelButtonName: 'Cancel',
            confirmButtonName: 'Save',
            credentialId
        }
        setSpecificCredentialDialogProps(dialogProp)
        setShowSpecificCredentialDialog(true)
    }

    const addAsyncOption = async () => {
        try {
            let names = ''
            if (inputParam.credentialNames.length > 1) {
                names = inputParam.credentialNames.join('&')
            } else {
                names = inputParam.credentialNames[0]
            }
            const componentCredentialsResp = await credentialsApi.getSpecificComponentCredential(names)
            if (componentCredentialsResp.data) {
                if (Array.isArray(componentCredentialsResp.data)) {
                    const dialogProp = {
                        title: 'Add New Credential',
                        componentsCredentials: componentCredentialsResp.data
                    }
                    setCredentialListDialogProps(dialogProp)
                    setShowCredentialListDialog(true)
                } else {
                    const dialogProp = {
                        type: 'ADD',
                        cancelButtonName: 'Cancel',
                        confirmButtonName: 'Add',
                        credentialComponent: componentCredentialsResp.data
                    }
                    setSpecificCredentialDialogProps(dialogProp)
                    setShowSpecificCredentialDialog(true)
                }
            }
        } catch (error) {
            console.error(error)
        }
    }

    const onConfirmAsyncOption = (selectedCredentialId = '') => {
        setCredentialId(selectedCredentialId)
        setReloadTimestamp(Date.now().toString())
        setSpecificCredentialDialogProps({})
        setShowSpecificCredentialDialog(false)
        onSelect(selectedCredentialId)
    }

    const onCredentialSelected = (credentialComponent) => {
        setShowCredentialListDialog(false)
        const dialogProp = {
            type: 'ADD',
            cancelButtonName: 'Cancel',
            confirmButtonName: 'Add',
            credentialComponent
        }
        setSpecificCredentialDialogProps(dialogProp)
        setShowSpecificCredentialDialog(true)
    }

    useEffect(() => {
        setCredentialId(data?.credential || (data?.inputs && data.inputs[FLOWISE_CREDENTIAL_ID]) || '')
    }, [data])

    // With no key picked yet and exactly one saved key that fits this card, pick it.
    const hasPick = Boolean(data?.credential || data?.inputs?.[FLOWISE_CREDENTIAL_ID])
    const fitNames = (inputParam?.credentialNames || []).join('&credentialName=')
    useEffect(() => {
        if (!pickOnlyFit || disabled || hasPick || inputParam?.type !== 'credential' || inputParam?.optional || !fitNames) return undefined
        let cancelled = false
        credentialsApi
            .getCredentialsByName(fitNames)
            .then((resp) => {
                const id = onlyFit(resp?.data || [])
                if (cancelled || !id) return
                setCredentialId(id)
                setReloadTimestamp(Date.now().toString())
                onSelect(id, { picked: 'only-fit' })
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pickOnlyFit, disabled, hasPick, fitNames])

    const analystInputsKey = data?.name === 'postgreSQLMCP' ? JSON.stringify(data.inputs || {}) : ''
    useEffect(() => {
        if (data?.name !== 'postgreSQLMCP') {
            setCredentialHint('')
            return undefined
        }
        let cancelled = false
        let inputs = {}
        try {
            inputs = analystInputsKey ? JSON.parse(analystInputsKey) : {}
        } catch {
            inputs = {}
        }
        nodesApi
            .executeNodeLoadMethod('postgreSQLMCP', { loadMethod: 'listActions', inputs })
            .then((resp) => {
                if (!cancelled) {
                    const hint = postgresCredentialHint(resp?.data)
                    setCredentialHint(hint)
                    onHint?.(hint)
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCredentialHint('')
                    onHint?.('')
                }
            })
        return () => {
            cancelled = true
        }
    }, [data?.name, analystInputsKey])

    return (
        <div ref={ref}>
            {inputParam && (
                <>
                    {inputParam.type === 'credential' && (
                        <div key={reloadTimestamp} style={{ display: 'flex', flexDirection: 'row' }}>
                            <AsyncDropdown
                                disabled={disabled}
                                name={inputParam.name}
                                nodeData={data}
                                value={credentialId ?? 'choose an option'}
                                isCreateNewOption={hasPermission('credentials:create')}
                                credentialNames={inputParam.credentialNames}
                                emptyCredentialText={credentialHint}
                                onSelect={(newValue) => {
                                    setCredentialId(newValue)
                                    onSelect(newValue)
                                }}
                                onCreateNew={() => addAsyncOption(inputParam.name)}
                            />
                            {credentialId && hasPermission('credentials:update') && (
                                <IconButton title='Edit' color='primary' size='small' onClick={() => editCredential(credentialId)}>
                                    <IconEdit />
                                </IconButton>
                            )}
                        </div>
                    )}
                </>
            )}
            {showSpecificCredentialDialog && (
                <AddEditCredentialDialog
                    show={showSpecificCredentialDialog}
                    dialogProps={specificCredentialDialogProps}
                    onCancel={() => setShowSpecificCredentialDialog(false)}
                    onConfirm={onConfirmAsyncOption}
                ></AddEditCredentialDialog>
            )}
            {showCredentialListDialog && (
                <CredentialListDialog
                    show={showCredentialListDialog}
                    dialogProps={credentialListDialogProps}
                    onCancel={() => setShowCredentialListDialog(false)}
                    onCredentialSelected={onCredentialSelected}
                ></CredentialListDialog>
            )}
        </div>
    )
}

CredentialInputHandler.propTypes = {
    inputParam: PropTypes.object,
    data: PropTypes.object,
    onSelect: PropTypes.func,
    onHint: PropTypes.func,
    disabled: PropTypes.bool,
    pickOnlyFit: PropTypes.bool
}

export default CredentialInputHandler
