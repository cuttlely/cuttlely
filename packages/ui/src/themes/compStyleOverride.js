// Disabled buttons keep a readable label (WCAG AA needs 4.5:1).
// Dark theme: label #c3c7cf on fill #33363d is about 7.1:1.
export const DARK_DISABLED_LABEL = '#c3c7cf'
export const DARK_DISABLED_FILL = '#33363d'
// Light theme: label #555a66 on fill #e3e5ea is about 5.5:1, and about 6.9:1 on white paper.
export const LIGHT_DISABLED_LABEL = '#555a66'
export const LIGHT_DISABLED_FILL = '#e3e5ea'

// Dark theme Alerts, per severity: icon, text, fill, and border. Each text color reads at 4.5:1 or better on its fill over the dark paper.
export const DARK_ALERT = {
    error: { icon: '#f47067', text: '#ffc4bf', fill: 'rgba(244, 67, 54, 0.1)', border: 'rgba(244, 67, 54, 0.5)' },
    warning: { icon: '#ffa726', text: '#ffd782', fill: 'rgba(255, 167, 38, 0.08)', border: 'rgba(255, 167, 38, 0.5)' },
    info: { icon: '#4fc3f7', text: '#b3e5fc', fill: 'rgba(41, 182, 246, 0.08)', border: 'rgba(41, 182, 246, 0.5)' },
    success: { icon: '#66bb6a', text: '#c8e6c9', fill: 'rgba(102, 187, 106, 0.08)', border: 'rgba(102, 187, 106, 0.5)' }
}
const SEVERITIES = Object.keys(DARK_ALERT)
const cap = (word) => word[0].toUpperCase() + word.slice(1)

// The dark theme paints every SvgIcon white. Inside an Alert, the icon takes the severity color and a checkbox
// takes the Alert's text color; the nested selectors outrank the plain root rule.
const darkAlertIcons = () => ({
    '.MuiAlert-icon &, .MuiAlert-root .MuiCheckbox-root &': { color: 'inherit' },
    ...Object.fromEntries(
        SEVERITIES.flatMap((severity) => [
            [`.MuiAlert-standard${cap(severity)} .MuiAlert-icon &`, { color: DARK_ALERT[severity].icon }],
            [`.MuiAlert-standard${cap(severity)} .MuiCheckbox-root &`, { color: DARK_ALERT[severity].text }]
        ])
    )
})

const darkAlerts = () =>
    Object.fromEntries(
        SEVERITIES.map((severity) => [
            `standard${cap(severity)}`,
            {
                color: DARK_ALERT[severity].text,
                backgroundColor: DARK_ALERT[severity].fill,
                border: `1px solid ${DARK_ALERT[severity].border}`,
                '& .MuiAlert-icon': { color: DARK_ALERT[severity].icon }
            }
        ])
    )

// The palette mode stays 'light' in the dark theme, so MUI's unselected ToggleButton label (action.active) is near-black there.
// Dark theme: #c3c7cf reads about 10.2:1 on the dark page and about 9.2:1 on the hover fill.
export const DARK_TOGGLE_LABEL = '#c3c7cf'
// Light theme: MUI's default reads 4.53:1 on the hover fill; #666666 is about 5.7:1 on white and 5.4:1 on that fill.
export const LIGHT_TOGGLE_LABEL = '#666666'

const toggleButton = (dark, colors) => ({
    color: dark ? DARK_TOGGLE_LABEL : LIGHT_TOGGLE_LABEL,
    '&.Mui-focusVisible': {
        outline: `2px solid ${dark ? colors?.darkPrimaryAccent : colors?.primaryMain}`,
        outlineOffset: -2
    }
})

const disabledButton = (dark) => ({
    '&.Mui-disabled': { color: dark ? DARK_DISABLED_LABEL : LIGHT_DISABLED_LABEL },
    '&.MuiButton-contained.Mui-disabled': { backgroundColor: dark ? DARK_DISABLED_FILL : LIGHT_DISABLED_FILL },
    '&.MuiButton-outlined.Mui-disabled': { borderColor: dark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(0, 0, 0, 0.23)' }
})

export default function componentStyleOverrides(theme) {
    const bgColor = theme.colors?.grey50
    return {
        MuiCssBaseline: {
            styleOverrides: {
                body: {
                    scrollbarWidth: 'thin',
                    scrollbarColor: theme?.customization?.isDarkMode
                        ? `${theme.colors?.grey500} ${theme.colors?.darkPrimaryMain}`
                        : `${theme.colors?.grey300} ${theme.paper}`,
                    '&::-webkit-scrollbar, & *::-webkit-scrollbar': {
                        width: 12,
                        height: 12,
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.darkPrimaryMain : theme.paper
                    },
                    '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': {
                        borderRadius: 8,
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.grey500 : theme.colors?.grey300,
                        minHeight: 24,
                        border: `3px solid ${theme?.customization?.isDarkMode ? theme.colors?.darkPrimaryMain : theme.paper}`
                    },
                    '&::-webkit-scrollbar-thumb:focus, & *::-webkit-scrollbar-thumb:focus': {
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.darkPrimary200 : theme.colors?.grey500
                    },
                    '&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active': {
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.darkPrimary200 : theme.colors?.grey500
                    },
                    '&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover': {
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.darkPrimary200 : theme.colors?.grey500
                    },
                    '&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner': {
                        backgroundColor: theme?.customization?.isDarkMode ? theme.colors?.darkPrimaryMain : theme.paper
                    }
                }
            }
        },
        MuiButton: {
            styleOverrides: {
                root: {
                    fontWeight: 500,
                    borderRadius: '4px',
                    // A disabled label stays readable in both themes (4.5:1 or better on its fill and on the page).
                    ...disabledButton(!!theme?.customization?.isDarkMode)
                },
                // Filled violet buttons: Royal on hover in light; on dark the lighter violet steps down to #9470f7 (Ink label 5.44:1).
                containedPrimary: theme?.customization?.isDarkMode
                    ? { '&:hover': { backgroundColor: theme.colors?.darkPrimaryAccentHover } }
                    : { '&:hover': { backgroundColor: theme.colors?.primaryDark } }
            }
        },
        MuiToggleButton: {
            styleOverrides: {
                root: toggleButton(!!theme?.customization?.isDarkMode, theme.colors)
            }
        },
        MuiSvgIcon: {
            styleOverrides: {
                root: {
                    color: theme?.customization?.isDarkMode ? theme.colors?.paper : 'inherit',
                    ...(theme?.customization?.isDarkMode ? darkAlertIcons() : {})
                }
            }
        },
        MuiAlert: {
            styleOverrides: theme?.customization?.isDarkMode ? darkAlerts() : {}
        },
        MuiPaper: {
            defaultProps: {
                elevation: 0
            },
            styleOverrides: {
                root: {
                    backgroundImage: 'none'
                },
                rounded: {
                    borderRadius: `${theme?.customization?.borderRadius}px`
                }
            }
        },
        MuiCardHeader: {
            styleOverrides: {
                root: {
                    color: theme.colors?.textDark,
                    padding: '24px'
                },
                title: {
                    fontSize: '1.125rem'
                }
            }
        },
        MuiCardContent: {
            styleOverrides: {
                root: {
                    padding: '24px'
                }
            }
        },
        MuiCardActions: {
            styleOverrides: {
                root: {
                    padding: '24px'
                }
            }
        },
        MuiListItemButton: {
            styleOverrides: {
                root: {
                    color: theme.darkTextPrimary,
                    paddingTop: '10px',
                    paddingBottom: '10px',
                    '&.Mui-selected': {
                        color: theme.menuSelected,
                        backgroundColor: theme.menuSelectedBack,
                        '&:hover': {
                            backgroundColor: theme.menuSelectedBack
                        },
                        '& .MuiListItemIcon-root': {
                            color: theme.menuSelected
                        }
                    },
                    '&:hover': {
                        backgroundColor: theme.menuSelectedBack,
                        color: theme.menuSelected,
                        '& .MuiListItemIcon-root': {
                            color: theme.menuSelected
                        }
                    }
                }
            }
        },
        MuiListItemIcon: {
            styleOverrides: {
                root: {
                    color: theme.darkTextPrimary,
                    minWidth: '36px'
                }
            }
        },
        MuiListItemText: {
            styleOverrides: {
                primary: {
                    color: theme.textDark
                }
            }
        },
        MuiInputBase: {
            styleOverrides: {
                input: {
                    color: theme.textDark,
                    '&::placeholder': {
                        color: theme.darkTextSecondary,
                        fontSize: '0.875rem'
                    },
                    '&.Mui-disabled': {
                        WebkitTextFillColor: theme?.customization?.isDarkMode ? theme.colors?.grey500 : theme.darkTextSecondary
                    }
                }
            }
        },
        MuiOutlinedInput: {
            styleOverrides: {
                root: {
                    background: theme?.customization?.isDarkMode ? theme.colors?.darkPrimary800 : bgColor,
                    borderRadius: `${theme?.customization?.borderRadius}px`,
                    '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: theme.colors?.grey400
                    },
                    '&:hover $notchedOutline': {
                        borderColor: theme.colors?.primaryLight
                    },
                    '&.MuiInputBase-multiline': {
                        padding: 1
                    }
                },
                input: {
                    fontWeight: 500,
                    background: theme?.customization?.isDarkMode ? theme.colors?.darkPrimary800 : bgColor,
                    padding: '15.5px 14px',
                    borderRadius: `${theme?.customization?.borderRadius}px`,
                    '&.MuiInputBase-inputSizeSmall': {
                        padding: '10px 14px',
                        '&.MuiInputBase-inputAdornedStart': {
                            paddingLeft: 0
                        }
                    }
                },
                inputAdornedStart: {
                    paddingLeft: 4
                },
                notchedOutline: {
                    borderRadius: `${theme?.customization?.borderRadius}px`
                }
            }
        },
        MuiSlider: {
            styleOverrides: {
                root: {
                    '&.Mui-disabled': {
                        color: theme.colors?.grey300
                    }
                },
                mark: {
                    backgroundColor: theme.paper,
                    width: '4px'
                },
                valueLabel: {
                    color: theme?.colors?.primaryLight
                }
            }
        },
        MuiDivider: {
            styleOverrides: {
                root: {
                    borderColor: theme.divider,
                    opacity: 1
                }
            }
        },
        MuiAvatar: {
            styleOverrides: {
                root: {
                    color: theme.colors?.primaryDark,
                    background: theme.colors?.primary200
                }
            }
        },
        MuiChip: {
            styleOverrides: {
                root: {
                    '&.MuiChip-deletable .MuiChip-deleteIcon': {
                        color: 'inherit'
                    }
                }
            }
        },
        MuiTooltip: {
            styleOverrides: {
                tooltip: {
                    color: theme?.customization?.isDarkMode ? theme.colors?.paper : theme.paper,
                    background: theme.colors?.grey700
                }
            }
        },
        MuiAutocomplete: {
            styleOverrides: {
                option: {
                    '&:hover': {
                        background: theme?.customization?.isDarkMode ? '#233345 !important' : ''
                    }
                }
            }
        }
    }
}
