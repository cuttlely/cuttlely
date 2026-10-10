import { createPortal } from 'react-dom'
import { useRef } from 'react'
import PropTypes from 'prop-types'
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material'

// A canvas that already has cards is never replaced silently: Start a new one is the default.
const BuildLandingDialog = ({ show, title, onStartNew, onReplace, onCancel }) => {
    const portalElement = document.getElementById('portal')
    const startNewRef = useRef(null)
    const component = show ? (
        <Dialog
            open={show}
            onClose={onCancel}
            aria-labelledby='build-landing-title'
            maxWidth='xs'
            fullWidth
            TransitionProps={{ onEntered: () => startNewRef.current?.focus() }}
        >
            <DialogTitle id='build-landing-title' sx={{ fontSize: '1rem' }}>
                Your canvas already has cards
            </DialogTitle>
            <DialogContent>
                <DialogContentText>
                    {title ? `"${title}" is ready. ` : ''}Start a new one keeps this canvas as it is. Replace swaps the cards here, and Undo
                    brings them back.
                </DialogContentText>
            </DialogContent>
            <DialogActions sx={{ pb: 2, pr: 2 }}>
                <Button onClick={onReplace} color='warning'>
                    Replace this canvas
                </Button>
                <Button variant='contained' ref={startNewRef} onClick={onStartNew}>
                    Start a new one
                </Button>
            </DialogActions>
        </Dialog>
    ) : null
    return createPortal(component, portalElement)
}

BuildLandingDialog.propTypes = {
    show: PropTypes.bool,
    title: PropTypes.string,
    onStartNew: PropTypes.func,
    onReplace: PropTypes.func,
    onCancel: PropTypes.func
}

export default BuildLandingDialog
