import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'

import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, OutlinedInput, TextField, Typography } from '@mui/material'

import { StyledButton } from '@/ui-component/button/StyledButton'
import datasetApi from '@/api/dataset'
import useNotifier from '@/utils/useNotifier'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

export function questionBeforeAnswer(messages, answer) {
    if (!answer || !Array.isArray(messages)) return ''
    const index = messages.findIndex((item) => item === answer || (answer.id && item.id === answer.id))
    if (index < 0) return ''
    for (let i = index - 1; i >= 0; i -= 1) {
        const role = messages[i].type || messages[i].role
        if (role === 'timeMessage') continue
        if (role === 'userMessage') return String(messages[i].message ?? messages[i].content ?? '')
        if (role === 'apiMessage') return ''
    }
    return ''
}

export function AddToTestSetForm({
    question,
    expected,
    onExpectedChange,
    datasets,
    datasetId,
    onDatasetChange,
    canCreate,
    showNew,
    onShowNew,
    newName,
    onNewName,
    onCreate,
    creating,
    saving,
    onSave,
    onCancel
}) {
    const missingQuestion = !String(question || '').trim()
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert severity='warning'>
                Real messages can contain personal data. Check the question and the expected answer before saving.
            </Alert>
            <Box>
                <Typography variant='subtitle2'>Question</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap' }}>
                    {missingQuestion ? 'No question was found for this answer.' : question}
                </Typography>
            </Box>
            <Box>
                <Typography variant='subtitle2'>Expected answer</Typography>
                <OutlinedInput
                    multiline
                    minRows={3}
                    fullWidth
                    value={expected}
                    onChange={(event) => onExpectedChange(event.target.value)}
                    inputProps={{ 'aria-label': 'Expected answer' }}
                />
            </Box>
            <Box>
                <Typography variant='subtitle2'>Dataset</Typography>
                <TextField
                    select
                    fullWidth
                    value={datasetId}
                    onChange={(event) => onDatasetChange(event.target.value)}
                    SelectProps={{ native: true, inputProps: { 'aria-label': 'Dataset' } }}
                >
                    <option value=''>Choose a dataset</option>
                    {datasets.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))}
                </TextField>
            </Box>
            {canCreate ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <Button variant='text' sx={{ textTransform: 'none', width: 'max-content' }} onClick={() => onShowNew(true)}>
                        New dataset
                    </Button>
                    {showNew ? (
                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            <OutlinedInput
                                size='small'
                                value={newName}
                                placeholder='Dataset name'
                                onChange={(event) => onNewName(event.target.value)}
                                inputProps={{ 'aria-label': 'New dataset name' }}
                            />
                            <Button
                                variant='outlined'
                                sx={{ textTransform: 'none' }}
                                disabled={creating || !newName.trim()}
                                onClick={onCreate}
                            >
                                Create dataset
                            </Button>
                        </Box>
                    ) : null}
                </Box>
            ) : null}
            <DialogActions sx={{ px: 0 }}>
                <Button variant='outlined' sx={{ textTransform: 'none' }} onClick={onCancel}>
                    Cancel
                </Button>
                <StyledButton variant='contained' disabled={saving || creating || missingQuestion || !datasetId} onClick={onSave}>
                    Save
                </StyledButton>
            </DialogActions>
        </Box>
    )
}

AddToTestSetForm.propTypes = {
    question: PropTypes.string,
    expected: PropTypes.string,
    onExpectedChange: PropTypes.func,
    datasets: PropTypes.array,
    datasetId: PropTypes.string,
    onDatasetChange: PropTypes.func,
    canCreate: PropTypes.bool,
    showNew: PropTypes.bool,
    onShowNew: PropTypes.func,
    newName: PropTypes.string,
    onNewName: PropTypes.func,
    onCreate: PropTypes.func,
    creating: PropTypes.bool,
    saving: PropTypes.bool,
    onSave: PropTypes.func,
    onCancel: PropTypes.func
}

const AddToTestSetDialog = ({ show, messageId, question, answer, canCreate, onCancel, onSaved }) => {
    const dispatch = useDispatch()
    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [expected, setExpected] = useState(answer || '')
    const [datasets, setDatasets] = useState([])
    const [datasetId, setDatasetId] = useState('')
    const [showNew, setShowNew] = useState(false)
    const [newName, setNewName] = useState('')
    const [creating, setCreating] = useState(false)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!show) return
        setExpected(answer || '')
        setDatasetId('')
        setShowNew(false)
        setNewName('')
    }, [show, messageId, answer])

    useEffect(() => {
        if (!show) return undefined
        let cancelled = false
        datasetApi
            .getAllDatasets()
            .then((response) => {
                if (cancelled) return
                const list = Array.isArray(response.data) ? response.data : response.data?.data || []
                setDatasets(list)
            })
            .catch(() => {
                if (!cancelled) setDatasets([])
            })
        return () => {
            cancelled = true
        }
    }, [show])

    const report = (message) => {
        enqueueSnackbar({
            message,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'error',
                persist: true,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        Close
                    </Button>
                )
            }
        })
    }

    const onCreate = async () => {
        const name = newName.trim()
        if (!name) return
        setCreating(true)
        try {
            const response = await datasetApi.createDataset({ name, description: '' })
            const created = response.data
            if (created?.id) {
                setDatasets((current) => [created, ...current.filter((item) => item.id !== created.id)])
                setDatasetId(created.id)
                setShowNew(false)
                setNewName('')
            }
        } catch (error) {
            const message = error?.response?.data?.message || 'Could not create the dataset'
            report(message)
        } finally {
            setCreating(false)
        }
    }

    const onSave = async () => {
        if (!datasetId || !messageId) return
        setSaving(true)
        try {
            await datasetApi.addDatasetRowFromChatMessage({
                datasetId,
                messageId,
                output: expected
            })
            enqueueSnackbar({
                message: 'Added to the test set',
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success'
                }
            })
            if (onSaved) onSaved()
        } catch (error) {
            const message = error?.response?.data?.message || 'Could not add this answer to the dataset'
            report(message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={Boolean(show)} onClose={onCancel} fullWidth maxWidth='sm' aria-labelledby='add-to-test-set-title'>
            <DialogTitle id='add-to-test-set-title'>Add to test set</DialogTitle>
            <DialogContent>
                <AddToTestSetForm
                    question={question}
                    expected={expected}
                    onExpectedChange={setExpected}
                    datasets={datasets}
                    datasetId={datasetId}
                    onDatasetChange={setDatasetId}
                    canCreate={canCreate}
                    showNew={showNew}
                    onShowNew={setShowNew}
                    newName={newName}
                    onNewName={setNewName}
                    onCreate={onCreate}
                    creating={creating}
                    saving={saving}
                    onSave={onSave}
                    onCancel={onCancel}
                />
            </DialogContent>
        </Dialog>
    )
}

AddToTestSetDialog.propTypes = {
    show: PropTypes.bool,
    messageId: PropTypes.string,
    question: PropTypes.string,
    answer: PropTypes.string,
    canCreate: PropTypes.bool,
    onCancel: PropTypes.func,
    onSaved: PropTypes.func
}

export default AddToTestSetDialog
