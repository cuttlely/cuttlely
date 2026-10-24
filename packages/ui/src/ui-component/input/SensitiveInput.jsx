import { useState } from 'react'
import PropTypes from 'prop-types'
import { FormControl, OutlinedInput } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { REDACTED_CREDENTIAL_VALUE } from '@/store/constant'

const MULTILINE_DOTS = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

export const SensitiveInput = ({ inputParam, value, onChange, disabled = false }) => {
    const theme = useTheme()
    const [myValue, setMyValue] = useState(value ?? '')

    const isUrl = inputParam?.type === 'url'
    const isMultilinePassword = !!inputParam?.rows && inputParam?.type === 'password'
    const isRedactedMultiline = isMultilinePassword && myValue === REDACTED_CREDENTIAL_VALUE

    const inputSx = {
        '& .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.grey[900] + 25
        }
    }

    // A URL is shown as text: a stored password in it comes back masked and is kept by the server on save.
    if (isUrl) {
        return (
            <FormControl sx={{ mt: 1, width: '100%' }} size='small'>
                <OutlinedInput
                    id={inputParam.name}
                    size='small'
                    disabled={disabled}
                    type='text'
                    placeholder={inputParam.placeholder}
                    value={myValue}
                    name={inputParam.name}
                    onChange={(e) => {
                        setMyValue(e.target.value)
                        onChange(e.target.value)
                    }}
                    sx={inputSx}
                />
            </FormControl>
        )
    }

    return (
        <FormControl sx={{ mt: 1, width: '100%' }} size='small'>
            <OutlinedInput
                id={inputParam.name}
                size='small'
                disabled={disabled}
                type='password'
                placeholder={inputParam.placeholder}
                multiline={isMultilinePassword}
                rows={isMultilinePassword ? inputParam.rows ?? 1 : undefined}
                value={isRedactedMultiline ? MULTILINE_DOTS : myValue}
                name={inputParam.name}
                onChange={(e) => {
                    setMyValue(e.target.value)
                    onChange(e.target.value)
                }}
                onFocus={() => {
                    if (isRedactedMultiline) {
                        setMyValue('')
                        onChange('')
                    }
                }}
                onBlur={(e) => {
                    if (isMultilinePassword && e.target.value === '') {
                        setMyValue(REDACTED_CREDENTIAL_VALUE)
                        onChange(REDACTED_CREDENTIAL_VALUE)
                    }
                }}
                sx={inputSx}
            />
        </FormControl>
    )
}

SensitiveInput.propTypes = {
    inputParam: PropTypes.object,
    value: PropTypes.string,
    onChange: PropTypes.func,
    disabled: PropTypes.bool
}
