import PropTypes from 'prop-types'
import { Box, Card, Link, Typography } from '@mui/material'
import { IconDownload, IconFileTypeCsv, IconFileTypeDocx, IconFileTypePdf, IconFileTypeXls } from '@tabler/icons-react'
import { baseURL } from '@/store/constant'
import { fileArtifactHref, fileArtifactName } from '@/utils/chatArtifacts'

const ICONS = { pdf: IconFileTypePdf, docx: IconFileTypeDocx, xlsx: IconFileTypeXls, csv: IconFileTypeCsv }

// A PDF, DOCX, XLSX or CSV file from a harness specialist, as a download card in the chat.
const FileArtifact = ({ item }) => {
    const href = fileArtifactHref(item, baseURL)
    if (!href) return null
    const name = fileArtifactName(item)
    const Icon = ICONS[item.type] || IconDownload
    return (
        <Card variant='outlined' sx={{ mt: 1, mb: 1, flex: '0 0 auto', maxWidth: 420 }}>
            <Link
                href={href}
                download={name}
                underline='none'
                color='inherit'
                data-testid='chat-file-artifact'
                aria-label={`Download ${name}`}
                sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1 }}
            >
                <Icon size={24} stroke={1.6} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant='body2' sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                        {name}
                    </Typography>
                    <Typography variant='caption' color='text.secondary'>
                        {item.type.toUpperCase()} · Download
                    </Typography>
                </Box>
                <IconDownload size={18} stroke={1.6} />
            </Link>
        </Card>
    )
}

FileArtifact.propTypes = {
    item: PropTypes.shape({ type: PropTypes.string, data: PropTypes.string, name: PropTypes.string }).isRequired
}

export default FileArtifact
