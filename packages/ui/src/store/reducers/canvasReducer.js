// action - state management
import * as actionTypes from '../actions'

export const initialState = {
    isDirty: false,
    editRev: 0,
    chatflow: null,
    canvasDialogShow: false,
    componentNodes: [],
    nodePackIndex: [],
    componentCredentials: []
}

// ==============================|| CANVAS REDUCER ||============================== //

const canvasReducer = (state = initialState, action) => {
    switch (action.type) {
        case actionTypes.SET_DIRTY:
            return {
                ...state,
                isDirty: true,
                editRev: (state.editRev || 0) + 1
            }
        case actionTypes.REMOVE_DIRTY:
            if (action.rev !== undefined && action.rev !== state.editRev) return state
            return {
                ...state,
                isDirty: false
            }
        case actionTypes.SET_CHATFLOW:
            return {
                ...state,
                chatflow: action.chatflow
            }
        case actionTypes.SHOW_CANVAS_DIALOG:
            return {
                ...state,
                canvasDialogShow: true
            }
        case actionTypes.HIDE_CANVAS_DIALOG:
            return {
                ...state,
                canvasDialogShow: false
            }
        case actionTypes.SET_COMPONENT_NODES:
            return {
                ...state,
                componentNodes: action.componentNodes
            }
        case actionTypes.SET_NODE_PACK_INDEX:
            return {
                ...state,
                nodePackIndex: action.nodePackIndex
            }
        case actionTypes.SET_COMPONENT_CREDENTIALS:
            return {
                ...state,
                componentCredentials: action.componentCredentials
            }
        default:
            return state
    }
}

export default canvasReducer
