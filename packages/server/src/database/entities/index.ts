import { ChatFlow } from './ChatFlow'
import { ChatMessage } from './ChatMessage'
import { ChatMessageFeedback } from './ChatMessageFeedback'
import { Credential } from './Credential'
import { Tool } from './Tool'
import { Assistant } from './Assistant'
import { Variable } from './Variable'
import { DocumentStore } from './DocumentStore'
import { DocumentStoreFileChunk } from './DocumentStoreFileChunk'
import { Lead } from './Lead'
import { UpsertHistory } from './UpsertHistory'
import { Dataset } from './Dataset'
import { DatasetRow } from './DatasetRow'
import { EvaluationRun } from './EvaluationRun'
import { Evaluation } from './Evaluation'
import { Evaluator } from './Evaluator'
import { ApiKey } from './ApiKey'
import { CustomTemplate } from './CustomTemplate'
import { Execution } from './Execution'
import { CustomMcpServer } from './CustomMcpServer'
import { LoginActivity } from './identity/LoginActivity'
import { LoginMethod } from './identity/LoginMethod'
import { Organization } from './identity/Organization'
import { OrganizationUser } from './identity/OrganizationUser'
import { Role } from './identity/Role'
import { User } from './identity/User'
import { Workspace } from './identity/Workspace'
import { WorkspaceShared } from './identity/WorkspaceShared'
import { WorkspaceUser } from './identity/WorkspaceUser'
import { ScheduleRecord } from './ScheduleRecord'
import { ScheduleTriggerLog } from './ScheduleTriggerLog'
import { FlowVersionState } from './FlowVersionState'
import { TokenUsageDay } from './TokenUsageDay'

export const entities = {
    ChatFlow,
    ChatMessage,
    ChatMessageFeedback,
    Credential,
    Tool,
    Assistant,
    Variable,
    UpsertHistory,
    DocumentStore,
    DocumentStoreFileChunk,
    Lead,
    Dataset,
    DatasetRow,
    Evaluation,
    EvaluationRun,
    Evaluator,
    ApiKey,
    User,
    LoginActivity,
    WorkspaceShared,
    CustomTemplate,
    Execution,
    CustomMcpServer,
    Organization,
    Role,
    OrganizationUser,
    Workspace,
    WorkspaceUser,
    LoginMethod,
    ScheduleRecord,
    ScheduleTriggerLog,
    FlowVersionState,
    TokenUsageDay
}
