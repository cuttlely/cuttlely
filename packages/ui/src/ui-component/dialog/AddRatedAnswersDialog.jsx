import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'

import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, OutlinedInput, TextField, Typography } from '@mui/material'

import { StyledButton } from '@/ui-component/button/StyledButton'
import datasetApi from '@/api/dataset'
import useNotifier from '@/utils/useNotifier'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

export function singleFeedbackRating(filter) {
    if (!Array.isArray(filter) || filter.length !== 1) return ''
    if (filter[0] === 'THUMBS_UP' || filter[0] === 'THUMBS_DOWN') return filter[0]
    return ''
}

export function ratingWindowLabel(rating) {
    return rating === 'THUMBS_DOWN' ? 'Negative' : 'Positive'
}

export function AddRatedAnswersForm({
    rating,
    days,
    onDaysChange,
    limit,
    onLimitChange,
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
    checking,
    adding,
    preview,
    onCheck,
    onAdd,
    onCancel
}) {
    const daysNumber = Number(days)
    const daysOk = Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= 90
    const limitOk = limit === '' || (Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 500)
    const ready = Boolean(datasetId) && daysOk && limitOk && !checking && !adding && !creating
    const thumbsDown = rating === 'THUMBS_DOWN'
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert severity='warning'>Real messages can contain personal data. Check the questions before adding them to a test set.</Alert>
            <Typography>
                {ratingWindowLabel(rating)} ratings on this flow. A thumbs-up answer is saved as the expected output.
                {thumbsDown ? ' A thumbs-down answer is not. Those rows are marked needs expected answer until you write one.' : ''}
            </Typography>
            <Box>
                <Typography variant='subtitle2'>Last days</Typography>
                <OutlinedInput
                    type='number'
                    fullWidth
                    value={days}
                    onChange={(event) => onDaysChange(event.target.value)}
                    inputProps={{ 'aria-label': 'Last days', min: 1, max: 90 }}
                />
            </Box>
            <Box>
                <Typography variant='subtitle2'>Limit</Typography>
                <OutlinedInput
                    type='number'
                    fullWidth
                    value={limit}
                    placeholder='500'
                    onChange={(event) => onLimitChange(event.target.value)}
                    inputProps={{ 'aria-label': 'Limit', min: 1, max: 500 }}
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
            {preview ? (
                <Box>
                    <Typography>
                        {preview.count} rated {preview.count === 1 ? 'answer' : 'answers'} will be added.
                    </Typography>
                    <Typography>{preview.skipped} already in this test set.</Typography>
                    {preview.preview.map((item) => (
                        <Typography key={item.feedbackId || item.messageId} variant='body2' sx={{ mt: 1 }}>
                            {item.input}
                            {item.needsExpectedAnswer ? ' — needs expected answer' : ''}
                        </Typography>
                    ))}
                </Box>
            ) : null}
            <DialogActions sx={{ px: 0 }}>
                <Button variant='outlined' sx={{ textTransform: 'none' }} onClick={onCancel}>
                    Cancel
                </Button>
                <Button variant='outlined' sx={{ textTransform: 'none' }} disabled={!ready} onClick={onCheck}>
                    See how many
                </Button>
                {preview ? (
                    <StyledButton variant='contained' disabled={!ready || preview.count < 1} onClick={onAdd}>
                        Add rated answers
                    </StyledButton>
                ) : null}
            </DialogActions>
        </Box>
    )
}

AddRatedAnswersForm.propTypes = {
    rating: PropTypes.string,
    days: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    onDaysChange: PropTypes.func,
    limit: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    onLimitChange: PropTypes.func,
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
    checking: PropTypes.bool,
    adding: PropTypes.bool,
    preview: PropTypes.object,
    onCheck: PropTypes.func,
    onAdd: PropTypes.func,
    onCancel: PropTypes.func
}

const AddRatedAnswersDialog = ({ show, flowId, rating, canCreate, onCancel, onSaved }) => {
    const dispatch = useDispatch()
    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [days, setDays] = useState('7')
    const [limit, setLimit] = useState('')
    const [datasets, setDatasets] = useState([])
    const [datasetId, setDatasetId] = useState('')
    const [showNew, setShowNew] = useState(false)
    const [newName, setNewName] = useState('')
    const [creating, setCreating] = useState(false)
    const [checking, setChecking] = useState(false)
    const [adding, setAdding] = useState(false)
    const [preview, setPreview] = useState(null)

    useEffect(() => {
        if (!show) return
        setDays('7')
        setLimit('')
        setDatasetId('')
        setShowNew(false)
        setNewName('')
        setPreview(null)
    }, [show, flowId, rating])

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

    const body = () => {
        const payload = {
            datasetId,
            flowId,
            rating,
            days: Number(days),
            dryRun: true
        }
        if (String(limit).trim() !== '') payload.limit = Number(limit)
        return payload
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
                setPreview(null)
            }
        } catch (error) {
            report(error?.response?.data?.message || 'Could not create the dataset')
        } finally {
            setCreating(false)
        }
    }

    const onCheck = async () => {
        if (!datasetId || !flowId || !rating) return
        setChecking(true)
        try {
            const response = await datasetApi.addDatasetRowsFromRatings(body())
            setPreview(response.data)
        } catch (error) {
            setPreview(null)
            report(error?.response?.data?.message || 'Could not count the rated answers')
        } finally {
            setChecking(false)
        }
    }

    const onAdd = async () => {
        if (!preview || preview.count < 1) return
        setAdding(true)
        try {
            const response = await datasetApi.addDatasetRowsFromRatings({ ...body(), dryRun: false })
            const added = response.data?.count ?? 0
            enqueueSnackbar({
                message: added === 1 ? 'Added 1 rated answer to the test set' : `Added ${added} rated answers to the test set`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success'
                }
            })
            if (onSaved) onSaved()
        } catch (error) {
            report(error?.response?.data?.message || 'Could not add the rated answers')
        } finally {
            setAdding(false)
        }
    }

    return (
        <Dialog open={Boolean(show)} onClose={onCancel} fullWidth maxWidth='sm' aria-labelledby='add-rated-answers-title'>
            <DialogTitle id='add-rated-answers-title'>Add rated answers to test set</DialogTitle>
            <DialogContent>
                <AddRatedAnswersForm
                    rating={rating}
                    days={days}
                    onDaysChange={(value) => {
                        setDays(value)
                        setPreview(null)
                    }}
                    limit={limit}
                    onLimitChange={(value) => {
                        setLimit(value)
                        setPreview(null)
                    }}
                    datasets={datasets}
                    datasetId={datasetId}
                    onDatasetChange={(value) => {
                        setDatasetId(value)
                        setPreview(null)
                    }}
                    canCreate={canCreate}
                    showNew={showNew}
                    onShowNew={setShowNew}
                    newName={newName}
                    onNewName={setNewName}
                    onCreate={onCreate}
                    creating={creating}
                    checking={checking}
                    adding={adding}
                    preview={preview}
                    onCheck={onCheck}
                    onAdd={onAdd}
                    onCancel={onCancel}
                />
            </DialogContent>
        </Dialog>
    )
}

AddRatedAnswersDialog.propTypes = {
    show: PropTypes.bool,
    flowId: PropTypes.string,
    rating: PropTypes.string,
    canCreate: PropTypes.bool,
    onCancel: PropTypes.func,
    onSaved: PropTypes.func
}

export default AddRatedAnswersDialog
