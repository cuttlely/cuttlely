import { HARNESS_LABEL } from '@/ui-component/flow/buildChoices'

// assets
import {
    IconTrash,
    IconFileUpload,
    IconFileExport,
    IconCopy,
    IconMessage,
    IconDatabaseExport,
    IconAdjustmentsHorizontal,
    IconUsers,
    IconTemplate
} from '@tabler/icons-react'

// constant
const icons = {
    IconTrash,
    IconFileUpload,
    IconFileExport,
    IconCopy,
    IconMessage,
    IconDatabaseExport,
    IconAdjustmentsHorizontal,
    IconUsers,
    IconTemplate
}

// ==============================|| SETTINGS MENU ITEMS ||============================== //

const settings = {
    id: 'settings',
    title: '',
    type: 'group',
    children: [
        {
            id: 'viewMessages',
            title: 'View Messages',
            type: 'item',
            url: '',
            icon: icons.IconMessage
        },
        {
            id: 'viewLeads',
            title: 'View Leads',
            type: 'item',
            url: '',
            icon: icons.IconUsers
        },
        {
            id: 'viewUpsertHistory',
            title: 'Upsert History',
            type: 'item',
            url: '',
            icon: icons.IconDatabaseExport,
            permission: 'chatflows:view'
        },
        {
            id: 'chatflowConfiguration',
            title: 'Configuration',
            type: 'item',
            url: '',
            permission: 'chatflows:config',
            icon: icons.IconAdjustmentsHorizontal
        },
        {
            id: 'saveAsTemplate',
            title: 'Save As Template',
            type: 'item',
            url: '',
            icon: icons.IconTemplate,
            permission: 'templates:flowexport'
        },
        {
            id: 'duplicateChatflow',
            title: 'Duplicate Chatflow',
            type: 'item',
            url: '',
            icon: icons.IconCopy,
            permission: 'chatflows:duplicate'
        },
        {
            id: 'loadChatflow',
            title: 'Import Flowise JSON',
            type: 'item',
            url: '',
            icon: icons.IconFileUpload,
            permission: 'chatflows:import'
        },
        {
            id: 'loadLangflow',
            title: 'Import Langflow JSON',
            type: 'item',
            url: '',
            icon: icons.IconFileUpload,
            permission: 'chatflows:import'
        },
        {
            id: 'exportChatflow',
            title: 'Export Chatflow',
            type: 'item',
            url: '',
            icon: icons.IconFileExport,
            permission: 'chatflows:export'
        },
        {
            id: 'deleteChatflow',
            title: 'Delete Chatflow',
            type: 'item',
            url: '',
            icon: icons.IconTrash,
            permission: 'chatflows:delete'
        }
    ]
}

export const settingsForCanvas = (isHarnessCanvas) => {
    if (!isHarnessCanvas) return settings
    return {
        ...settings,
        children: settings.children.map((item) => ({
            ...item,
            title: item.id === 'loadChatflow' ? `Load ${HARNESS_LABEL}` : item.title.split('Chatflow').join('Harness')
        }))
    }
}

export default settings
