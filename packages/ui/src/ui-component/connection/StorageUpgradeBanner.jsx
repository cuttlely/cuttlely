import { useEffect, useState } from 'react'
import { Alert } from '@mui/material'
import serverSettingsApi from '@/api/serverSettings'

export default function StorageUpgradeBanner() {
    const [paused, setPaused] = useState(false)
    useEffect(() => {
        let live = true
        const check = () =>
            serverSettingsApi
                .storagePause()
                .then(({ data }) => {
                    if (live) setPaused(data.paused === true)
                })
                .catch(() => {})
        const show = () => setPaused(true)
        window.addEventListener('cuttlely-storage-paused', show)
        check()
        const timer = paused ? setInterval(check, 5000) : null
        return () => {
            live = false
            clearInterval(timer)
            window.removeEventListener('cuttlely-storage-paused', show)
        }
    }, [paused])
    return paused ? (
        <Alert severity='info' role='status'>
            Storage upgrade in progress. New runs and chats are paused. Due schedules will resume after verification.
        </Alert>
    ) : null
}
