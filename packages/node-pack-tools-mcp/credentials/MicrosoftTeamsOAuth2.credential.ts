import { INodeParams, INodeCredential } from '@cuttlely/components/interface'

// Comprehensive scopes for Microsoft Teams operations
const scopes = [
    // Basic authentication
    'openid',
    'offline_access',

    // User permissions
    'User.Read',
    'User.ReadWrite.All',

    // Teams and Groups
    'Group.ReadWrite.All',
    'Team.ReadBasic.All',
    'Team.Create',
    'TeamMember.ReadWrite.All',

    // Channels
    'Channel.ReadBasic.All',
    'Channel.Create',
    'Channel.Delete.All',
    'ChannelMember.ReadWrite.All',

    // Chat operations
    'Chat.ReadWrite',
    'Chat.Create',
    'ChatMember.ReadWrite',

    // Messages
    'ChatMessage.Send',
    'ChatMessage.Read',
    'ChannelMessage.Send',
    'ChannelMessage.Read.All',

    // Reactions and advanced features
    'TeamsActivity.Send'
]

class MsoftTeamsOAuth2 implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]
    description: string

    constructor() {
        this.label = 'Microsoft Teams OAuth2'
        this.name = 'microsoftTeamsOAuth2'
        this.version = 1.0
        this.description =
            'Create the OAuth app with the provider first: <a target="_blank" href="https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app">provider guide</a>'
        this.inputs = [
            {
                label: 'Authorization URL',
                name: 'authorizationUrl',
                type: 'string',
                default: 'https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize'
            },
            {
                label: 'Access Token URL',
                name: 'accessTokenUrl',
                type: 'string',
                default: 'https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token'
            },
            {
                label: 'Client ID',
                name: 'clientId',
                type: 'string'
            },
            {
                label: 'Client Secret',
                name: 'clientSecret',
                type: 'password'
            },
            {
                label: 'Scope',
                name: 'scope',
                type: 'string',
                hidden: true,
                default: scopes.join(' ')
            }
        ]
    }
}

module.exports = { credClass: MsoftTeamsOAuth2 }
