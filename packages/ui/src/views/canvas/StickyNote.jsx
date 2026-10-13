import PropTypes from 'prop-types'
import { memo } from 'react'
import { useSelector } from 'react-redux'

// material-ui
import { useTheme, darken, lighten } from '@mui/material/styles'

// project imports
import NodeCardWrapper from '@/ui-component/cards/NodeCardWrapper'
import NodeActionBar, { useCardHover } from './NodeActionBar'
import { Box } from '@mui/material'
import { Input } from '@/ui-component/input/Input'

// const
import { normalizeNodeData } from '@/utils/normalizeCanvasFlow'

const StickyNote = ({ data }) => {
    normalizeNodeData(data)
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const [inputParam] = data.inputParams
    const { hovered, hoverProps } = useCardHover()

    const defaultColor = '#FFE770' // fallback color if data.color is not present
    const nodeColor = data.color || defaultColor

    const getBorderColor = () => {
        if (data.selected) return theme.palette.primary.main
        else if (customization?.isDarkMode) return theme.palette.grey[700]
        else return theme.palette.grey[900] + 50
    }

    const getBackgroundColor = () => {
        if (customization?.isDarkMode) {
            return data.selected ? darken(nodeColor, 0.7) : darken(nodeColor, 0.8)
        } else {
            return data.selected ? lighten(nodeColor, 0.1) : lighten(nodeColor, 0.2)
        }
    }

    return (
        <>
            <Box {...hoverProps} sx={{ position: 'relative' }}>
                <NodeActionBar data={data} hovered={hovered} selected={Boolean(data.selected)} includeInfo={false} />
                <NodeCardWrapper
                    content={false}
                    sx={{
                        padding: 0,
                        borderColor: getBorderColor(),
                        backgroundColor: getBackgroundColor()
                    }}
                    border={false}
                >
                    <Box>
                        <Input
                            key={data.id}
                            inputParam={inputParam}
                            onChange={(newValue) => (data.inputs[inputParam.name] = newValue)}
                            value={data.inputs[inputParam.name] ?? inputParam.default ?? ''}
                            nodes={[]}
                            edges={[]}
                            nodeId={data.id}
                        />
                    </Box>
                </NodeCardWrapper>
            </Box>
        </>
    )
}

StickyNote.propTypes = {
    data: PropTypes.object
}

export default memo(StickyNote)
