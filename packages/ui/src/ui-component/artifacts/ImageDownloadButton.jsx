import PropTypes from 'prop-types'
import { IconButton, Tooltip } from '@mui/material'
import { IconDownload } from '@tabler/icons-react'
import { baseURL } from '@/store/constant'
import { imageArtifactDownload } from '@/utils/chatArtifacts'

// A small download button over a PNG or JPEG artifact card. The card needs position: relative.
const ImageDownloadButton = ({ item }) => {
    const download = imageArtifactDownload(item, baseURL)
    if (!download) return null
    return (
        <Tooltip title={`Download ${download.name}`}>
            <IconButton
                component='a'
                href={download.href}
                download={download.name}
                size='small'
                data-testid='chat-image-download'
                aria-label={`Download ${download.name}`}
                sx={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    bgcolor: 'background.paper',
                    boxShadow: 1,
                    '&:hover': { bgcolor: 'background.paper' }
                }}
            >
                <IconDownload size={16} stroke={1.8} />
            </IconButton>
        </Tooltip>
    )
}

ImageDownloadButton.propTypes = {
    item: PropTypes.shape({ type: PropTypes.string, data: PropTypes.string, name: PropTypes.string }).isRequired
}

export default ImageDownloadButton
