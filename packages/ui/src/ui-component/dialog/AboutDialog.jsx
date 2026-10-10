import { createPortal } from 'react-dom'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { Dialog, DialogContent, DialogTitle, TableContainer, Table, TableHead, TableRow, TableCell, TableBody, Paper } from '@mui/material'
import axios from 'axios'
import { baseURL } from '@/store/constant'

// The dialog only asks this server for its version. It does not call GitHub or any other site;
// the Releases link opens in the browser only when someone clicks it.
export const RELEASES_URL = 'https://github.com/cuttlely/cuttlely/releases'

const AboutDialog = ({ show, onCancel }) => {
    const portalElement = document.getElementById('portal')

    const [currentVersion, setCurrentVersion] = useState('')

    useEffect(() => {
        if (show) {
            axios
                .get(`${baseURL}/api/v1/version`, {
                    withCredentials: true,
                    headers: { 'Content-type': 'application/json', 'x-request-from': 'internal' }
                })
                .then((res) => setCurrentVersion(res.data?.version || ''))
                .catch((error) => {
                    console.error('Error fetching version:', error)
                })
        }
    }, [show])

    const component = show ? (
        <Dialog
            onClose={onCancel}
            open={show}
            fullWidth
            maxWidth='sm'
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                Cuttlely version
            </DialogTitle>
            <DialogContent>
                <TableContainer component={Paper}>
                    <Table aria-label='Cuttlely version'>
                        <TableHead>
                            <TableRow>
                                <TableCell>Current Version</TableCell>
                                <TableCell>Releases</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            <TableRow sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                                <TableCell component='th' scope='row'>
                                    {currentVersion}
                                </TableCell>
                                <TableCell>
                                    <a target='_blank' rel='noreferrer' href={RELEASES_URL}>
                                        See what is new
                                    </a>
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </TableContainer>
            </DialogContent>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AboutDialog.propTypes = {
    show: PropTypes.bool,
    onCancel: PropTypes.func
}

export default AboutDialog
