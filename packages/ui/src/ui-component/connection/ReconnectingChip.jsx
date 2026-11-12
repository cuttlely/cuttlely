import { useEffect, useState } from 'react'
import { Box } from '@mui/material'
import { useReconnectCount } from '@/store/context/ConnectionContext'
import { connectionChipTransition } from './connectionVisibility'

const ReconnectingChip = () => {
    const count = useReconnectCount()
    const [visible, setVisible] = useState(false)

    useEffect(() => {
        const transition = connectionChipTransition(count, visible)
        if (!transition.visible && transition.delay === null) {
            setVisible(false)
            return undefined
        }
        if (transition.delay === null) return undefined
        const timer = setTimeout(() => setVisible(true), transition.delay)
        return () => clearTimeout(timer)
    }, [count, visible])

    if (!visible || count <= 0) return null

    return (
        <Box
            role='status'
            aria-live='polite'
            sx={{
                position: 'fixed',
                top: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 20000,
                pointerEvents: 'none',
                px: 1.5,
                py: 0.75,
                borderRadius: 999,
                bgcolor: 'warning.main',
                color: 'warning.contrastText',
                boxShadow: 2,
                fontSize: '0.875rem',
                fontWeight: 600
            }}
        >
            Reconnecting…
        </Box>
    )
}

export default ReconnectingChip
