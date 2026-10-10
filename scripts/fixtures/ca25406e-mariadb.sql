/*M!999999\- enable the sandbox mode */ 

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `apikey` (
  `id` varchar(36) NOT NULL,
  `apiKey` varchar(255) NOT NULL,
  `apiSecret` varchar(255) NOT NULL,
  `keyName` varchar(255) NOT NULL,
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  `permissions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT json_array() CHECK (json_valid(`permissions`)),
  PRIMARY KEY (`id`),
  KEY `idx_apikey_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_apikey_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `assistant` (
  `id` varchar(36) NOT NULL,
  `credential` varchar(255) NOT NULL,
  `details` text NOT NULL,
  `iconSrc` varchar(255) DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  `type` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_assistant_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_assistant_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_flow` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `flowData` longtext DEFAULT NULL,
  `deployed` tinyint(4) DEFAULT NULL,
  `isPublic` tinyint(4) DEFAULT NULL,
  `apikeyid` varchar(255) DEFAULT NULL,
  `chatbotConfig` text DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `apiConfig` text DEFAULT NULL,
  `analytic` text DEFAULT NULL,
  `category` text DEFAULT NULL,
  `speechToText` text DEFAULT NULL,
  `type` varchar(20) NOT NULL DEFAULT 'CHATFLOW',
  `workspaceId` varchar(36) DEFAULT NULL,
  `followUpPrompts` text DEFAULT NULL,
  `textToSpeech` text DEFAULT NULL,
  `mcpServerConfig` longtext DEFAULT NULL,
  `webhookSecret` text DEFAULT NULL,
  `webhookSecretConfigured` tinyint(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_chat_flow_workspaceId` (`workspaceId`),
  KEY `IDX_chatflow_name` (`name`(191)),
  CONSTRAINT `fk_chat_flow_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_message` (
  `id` varchar(36) NOT NULL,
  `role` varchar(255) NOT NULL,
  `chatflowid` varchar(255) NOT NULL,
  `content` longtext DEFAULT NULL,
  `sourceDocuments` text DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `chatType` varchar(255) NOT NULL DEFAULT 'INTERNAL',
  `chatId` varchar(255) NOT NULL,
  `memoryType` varchar(255) DEFAULT NULL,
  `sessionId` varchar(255) DEFAULT NULL,
  `usedTools` longtext DEFAULT NULL,
  `fileAnnotations` text DEFAULT NULL,
  `fileUploads` text DEFAULT NULL,
  `leadEmail` text DEFAULT NULL,
  `agentReasoning` longtext DEFAULT NULL,
  `action` longtext DEFAULT NULL,
  `artifacts` longtext DEFAULT NULL,
  `followUpPrompts` text DEFAULT NULL,
  `executionId` text DEFAULT NULL,
  `reasonContent` longtext DEFAULT NULL,
  `harnessPayload` longtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `IDX_e574527322272fd838f4f0f3d3` (`chatflowid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_message_feedback` (
  `id` varchar(36) NOT NULL,
  `chatflowid` varchar(255) NOT NULL,
  `content` text DEFAULT NULL,
  `chatId` varchar(255) NOT NULL,
  `messageId` varchar(255) NOT NULL,
  `rating` varchar(255) NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `credential` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `credentialName` varchar(255) NOT NULL,
  `encryptedData` text NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_credential_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_credential_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `custom_mcp_server` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `serverUrl` text NOT NULL,
  `iconSrc` varchar(255) DEFAULT NULL,
  `color` varchar(255) DEFAULT NULL,
  `authType` varchar(255) NOT NULL DEFAULT 'NONE',
  `authConfig` text DEFAULT NULL,
  `tools` text DEFAULT NULL,
  `toolCount` int(11) NOT NULL DEFAULT 0,
  `status` varchar(255) NOT NULL DEFAULT 'PENDING',
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `IDX_custom_mcp_workspace_updated` (`workspaceId`,`updatedDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `custom_template` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `flowData` text NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `badge` varchar(255) DEFAULT NULL,
  `framework` varchar(255) DEFAULT NULL,
  `usecases` varchar(255) DEFAULT NULL,
  `type` varchar(30) DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_custom_template_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_custom_template_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `dataset` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_dataset_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_dataset_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `dataset_row` (
  `id` varchar(36) NOT NULL,
  `datasetId` varchar(36) NOT NULL,
  `input` longtext NOT NULL,
  `output` longtext DEFAULT NULL,
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `sequence_no` int(11) DEFAULT -1,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_bootstrap` (
  `id` int(11) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_local_session` (
  `id` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `token` varchar(255) NOT NULL,
  `expiresAt` datetime NOT NULL,
  `absoluteExpiresAt` datetime NOT NULL,
  `createdDate` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `IDX_identity_local_session_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `identity_login_failure` (
  `id` varchar(255) NOT NULL,
  `scope` varchar(32) NOT NULL,
  `subject` varchar(255) NOT NULL,
  `attemptedAt` bigint(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `document_store` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `loaders` longtext DEFAULT NULL,
  `whereUsed` text DEFAULT NULL,
  `status` varchar(20) NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `vectorStoreConfig` text DEFAULT NULL,
  `embeddingConfig` text DEFAULT NULL,
  `recordManagerConfig` text DEFAULT NULL,
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_document_store_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_document_store_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `document_store_file_chunk` (
  `id` varchar(36) NOT NULL,
  `docId` varchar(36) NOT NULL,
  `storeId` varchar(36) NOT NULL,
  `chunkNo` int(11) NOT NULL,
  `pageContent` longtext NOT NULL,
  `metadata` longtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `IDX_e76bae1780b77e56aab1h2asd4` (`docId`),
  KEY `IDX_e213b811b01405a42309a6a410` (`storeId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `evaluation` (
  `id` varchar(36) NOT NULL,
  `chatflowId` longtext NOT NULL,
  `datasetId` longtext NOT NULL,
  `name` varchar(255) NOT NULL,
  `chatflowName` varchar(255) NOT NULL,
  `datasetName` varchar(255) NOT NULL,
  `additionalConfig` longtext DEFAULT NULL,
  `average_metrics` longtext DEFAULT NULL,
  `status` varchar(10) NOT NULL,
  `evaluationType` varchar(20) NOT NULL,
  `runDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_evaluation_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_evaluation_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `evaluation_run` (
  `id` varchar(36) NOT NULL,
  `evaluationId` varchar(36) NOT NULL,
  `expectedOutput` longtext NOT NULL,
  `actualOutput` longtext NOT NULL,
  `evaluators` longtext DEFAULT NULL,
  `input` longtext DEFAULT NULL,
  `metrics` text DEFAULT NULL,
  `llmEvaluators` text DEFAULT NULL,
  `runDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `errors` longtext DEFAULT '[]',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `evaluator` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `type` varchar(25) DEFAULT NULL,
  `config` longtext DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_evaluator_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_evaluator_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `execution` (
  `id` varchar(36) NOT NULL,
  `executionData` longtext NOT NULL,
  `action` text DEFAULT NULL,
  `state` varchar(255) NOT NULL,
  `agentflowId` varchar(255) NOT NULL,
  `sessionId` varchar(255) NOT NULL,
  `isPublic` tinyint(1) DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `stoppedDate` datetime(6) DEFAULT NULL,
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_execution_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_execution_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `lead` (
  `id` varchar(36) NOT NULL,
  `chatflowid` varchar(255) NOT NULL,
  `chatId` varchar(255) NOT NULL,
  `name` text DEFAULT NULL,
  `email` text DEFAULT NULL,
  `phone` text DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `login_activity` (
  `id` varchar(36) NOT NULL,
  `username` varchar(255) DEFAULT NULL,
  `message` varchar(255) NOT NULL,
  `activity_code` int(11) NOT NULL,
  `attemptedDateTime` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `login_mode` varchar(25) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `login_method` (
  `id` varchar(36) NOT NULL DEFAULT uuid(),
  `organizationId` varchar(36) DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `config` text NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'enable',
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) DEFAULT NULL,
  `updatedBy` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_login_method_organizationId` (`organizationId`),
  KEY `fk_login_method_createdBy` (`createdBy`),
  KEY `fk_login_method_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_login_method_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_login_method_organizationId` FOREIGN KEY (`organizationId`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_login_method_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `migrations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `timestamp` bigint(20) NOT NULL,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=65 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization` (
  `id` varchar(36) NOT NULL DEFAULT uuid(),
  `name` varchar(100) NOT NULL DEFAULT 'Default Organization',
  `customerId` varchar(100) DEFAULT NULL,
  `subscriptionId` varchar(100) DEFAULT NULL,
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) NOT NULL,
  `updatedBy` varchar(36) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_organization_createdBy` (`createdBy`),
  KEY `fk_organization_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_organization_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_organization_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `organization_user` (
  `organizationId` varchar(36) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `roleId` varchar(36) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) NOT NULL,
  `updatedBy` varchar(36) NOT NULL,
  PRIMARY KEY (`organizationId`,`userId`),
  KEY `fk_organization_user_userId` (`userId`),
  KEY `fk_organization_user_roleId` (`roleId`),
  KEY `fk_organization_user_createdBy` (`createdBy`),
  KEY `fk_organization_user_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_organization_user_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_organization_user_organizationId` FOREIGN KEY (`organizationId`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_organization_user_roleId` FOREIGN KEY (`roleId`) REFERENCES `role` (`id`),
  CONSTRAINT `fk_organization_user_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_organization_user_userId` FOREIGN KEY (`userId`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `role` (
  `id` varchar(36) NOT NULL DEFAULT uuid(),
  `organizationId` varchar(36) DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `permissions` text NOT NULL,
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) DEFAULT NULL,
  `updatedBy` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_role_organizationId` (`organizationId`),
  KEY `fk_role_createdBy` (`createdBy`),
  KEY `fk_role_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_role_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_role_organizationId` FOREIGN KEY (`organizationId`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_role_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `schedule_record` (
  `id` varchar(36) NOT NULL,
  `triggerType` varchar(32) NOT NULL,
  `targetId` varchar(255) NOT NULL,
  `nodeId` text DEFAULT NULL,
  `cronExpression` text NOT NULL,
  `timezone` varchar(64) NOT NULL DEFAULT 'UTC',
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `scheduleInputMode` varchar(16) NOT NULL,
  `defaultInput` text DEFAULT NULL,
  `defaultForm` text DEFAULT NULL,
  `lastRunAt` datetime(6) DEFAULT NULL,
  `nextRunAt` datetime(6) DEFAULT NULL,
  `endDate` datetime(6) DEFAULT NULL,
  `workspaceId` varchar(255) NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  KEY `IDX_schedule_record_targetId` (`targetId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `schedule_trigger_log` (
  `id` varchar(36) NOT NULL,
  `scheduleRecordId` varchar(255) NOT NULL,
  `triggerType` varchar(32) NOT NULL,
  `targetId` varchar(255) NOT NULL,
  `executionId` varchar(255) DEFAULT NULL,
  `status` varchar(32) NOT NULL,
  `error` text DEFAULT NULL,
  `elapsedTimeMs` int(11) DEFAULT NULL,
  `scheduledAt` datetime(6) NOT NULL,
  `workspaceId` varchar(255) NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  KEY `IDX_schedule_trigger_log_scheduleRecordId` (`scheduleRecordId`),
  KEY `IDX_schedule_trigger_log_targetId` (`targetId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `tool` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `color` varchar(255) NOT NULL,
  `iconSrc` varchar(255) DEFAULT NULL,
  `schema` text DEFAULT NULL,
  `func` text DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tool_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_tool_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `upsert_history` (
  `id` varchar(36) NOT NULL,
  `chatflowid` varchar(255) NOT NULL,
  `result` text NOT NULL,
  `flowData` longtext DEFAULT NULL,
  `date` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  KEY `IDX_a0b59fd66f6e48d2b198123cb6` (`chatflowid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user` (
  `id` varchar(36) NOT NULL DEFAULT uuid(),
  `name` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL,
  `credential` text DEFAULT NULL,
  `tempToken` text DEFAULT NULL,
  `tokenExpiry` timestamp NULL DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'unverified',
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) NOT NULL,
  `updatedBy` varchar(36) NOT NULL,
  `ssoProvider` varchar(100) DEFAULT NULL,
  `ssoSubjectId` varchar(255) DEFAULT NULL,
  `externalId` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `IDX_user_externalId` (`externalId`),
  KEY `fk_user_createdBy` (`createdBy`),
  KEY `fk_user_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_user_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_user_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `variable` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `value` text NOT NULL,
  `type` varchar(255) DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `workspaceId` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_variable_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_variable_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspace` (
  `id` varchar(36) NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  `organizationId` varchar(36) NOT NULL,
  `createdBy` varchar(36) NOT NULL,
  `updatedBy` varchar(36) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_organizationId` (`organizationId`),
  KEY `fk_workspace_createdBy` (`createdBy`),
  KEY `fk_workspace_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_organizationId` FOREIGN KEY (`organizationId`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_workspace_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_workspace_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspace_shared` (
  `id` varchar(36) NOT NULL,
  `workspaceId` varchar(50) NOT NULL,
  `sharedItemId` varchar(50) NOT NULL,
  `itemType` varchar(50) NOT NULL,
  `createdDate` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `updatedDate` datetime(6) NOT NULL DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  KEY `idx_workspace_shared_workspaceId` (`workspaceId`),
  CONSTRAINT `fk_workspace_shared_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `workspace_user` (
  `workspaceId` varchar(36) NOT NULL,
  `userId` varchar(36) NOT NULL,
  `roleId` varchar(36) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'invited',
  `lastLogin` timestamp NULL DEFAULT NULL,
  `createdDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedDate` timestamp NOT NULL DEFAULT current_timestamp(),
  `createdBy` varchar(36) NOT NULL,
  `updatedBy` varchar(36) NOT NULL,
  PRIMARY KEY (`workspaceId`,`userId`),
  KEY `fk_workspace_user_userId` (`userId`),
  KEY `fk_workspace_user_roleId` (`roleId`),
  KEY `fk_workspace_user_createdBy` (`createdBy`),
  KEY `fk_workspace_user_updatedBy` (`updatedBy`),
  CONSTRAINT `fk_workspace_user_createdBy` FOREIGN KEY (`createdBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_workspace_user_roleId` FOREIGN KEY (`roleId`) REFERENCES `role` (`id`),
  CONSTRAINT `fk_workspace_user_updatedBy` FOREIGN KEY (`updatedBy`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_workspace_user_userId` FOREIGN KEY (`userId`) REFERENCES `user` (`id`),
  CONSTRAINT `fk_workspace_user_workspaceId` FOREIGN KEY (`workspaceId`) REFERENCES `workspace` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

/*M!999999\- enable the sandbox mode */ 

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

LOCK TABLES `migrations` WRITE;
/*!40000 ALTER TABLE `migrations` DISABLE KEYS */;
INSERT INTO `migrations` (`id`, `timestamp`, `name`) VALUES (1,1693840429259,'Init1693840429259'),
(2,1693997791471,'ModifyChatFlow1693997791471'),
(3,1693999022236,'ModifyChatMessage1693999022236'),
(4,1693999261583,'ModifyCredential1693999261583'),
(5,1694001465232,'ModifyTool1694001465232'),
(6,1694099200729,'AddApiConfig1694099200729'),
(7,1694432361423,'AddAnalytic1694432361423'),
(8,1694658767766,'AddChatHistory1694658767766'),
(9,1699325775451,'AddAssistantEntity1699325775451'),
(10,1699325775451,'AddVariableEntity1699325775451'),
(11,1699481607341,'AddUsedToolsToChatMessage1699481607341'),
(12,1699900910291,'AddCategoryToChatFlow1699900910291'),
(13,1700271021237,'AddFileAnnotationsToChatMessage1700271021237'),
(14,1701788586491,'AddFileUploadsToChatMessage1701788586491'),
(15,1706364937060,'AddSpeechToText1706364937060'),
(16,1707213626553,'AddFeedback1707213626553'),
(17,1709814301358,'AddUpsertHistoryEntity1709814301358'),
(18,1710832127079,'AddLead1710832127079'),
(19,1711538023578,'AddLeadToChatMessage1711538023578'),
(20,1711637331047,'AddDocumentStore1711637331047'),
(21,1714548873039,'AddEvaluation1714548873039'),
(22,1714548903384,'AddDatasets1714548903384'),
(23,1714679514451,'AddAgentReasoningToChatMessage1714679514451'),
(24,1714808591644,'AddEvaluator1714808591644'),
(25,1715861032479,'AddVectorStoreConfigToDocStore1715861032479'),
(26,1716300000000,'AddTypeToChatFlow1716300000000'),
(27,1720230151480,'AddApiKey1720230151480'),
(28,1720230151482,'AddAuthTables1720230151482'),
(29,1721078251523,'AddActionToChatMessage1721078251523'),
(30,1722301395521,'LongTextColumn1722301395521'),
(31,1725437498242,'AddWorkspace1725437498242'),
(32,1725629836652,'AddCustomTemplate1725629836652'),
(33,1726156258465,'AddArtifactsToChatMessage1726156258465'),
(34,1726654922034,'AddWorkspaceShared1726654922034'),
(35,1726655750383,'AddWorkspaceIdToCustomTemplate1726655750383'),
(36,1726666318346,'AddFollowUpPrompts1726666318346'),
(37,1727798417345,'AddOrganization1727798417345'),
(38,1729130948686,'LinkWorkspaceId1729130948686'),
(39,1729133111652,'LinkOrganizationId1729133111652'),
(40,1730519457880,'AddSSOColumns1730519457880'),
(41,1733011290987,'AddTypeToAssistant1733011290987'),
(42,1733752119696,'AddSeqNoToDatasetRow1733752119696'),
(43,1734074497540,'AddPersonalWorkspace1734074497540'),
(44,1737076223692,'RefactorEnterpriseDatabase1737076223692'),
(45,1738090872625,'AddExecutionEntity1738090872625'),
(46,1743758056188,'FixOpenSourceAssistantTable1743758056188'),
(47,1744964560174,'AddErrorToEvaluationRun1744964560174'),
(48,1746862866554,'ExecutionLinkWorkspaceId1746862866554'),
(49,1747902489801,'ModifyExecutionDataColumnType1747902489801'),
(50,1754986457485,'AddTextToSpeechToChatFlow1754986457485'),
(51,1755066758601,'ModifyChatflowType1755066758601'),
(52,1759419231100,'AddTextToSpeechToChatFlow1759419231100'),
(53,1759424809984,'AddChatFlowNameIndex1759424809984'),
(54,1764759496768,'AddReasonContentToChatMessage1764759496768'),
(55,1765000000000,'FixDocumentStoreFileChunkLongText1765000000000'),
(56,1765360298674,'AddApiKeyPermission1765360298674'),
(57,1766000000000,'AddCustomMcpServer1766000000000'),
(58,1767000000000,'AddMcpServerConfigToChatFlow1767000000000'),
(59,1772000000000,'AddScheduleEntities1772000000000'),
(60,1776240000003,'AddWebhookSecretToChatFlow1776240000003'),
(61,1780000000000,'AddSSOIdentityBinding1780000000000'),
(62,1781000000000,'AddHarnessPayloadToChatMessage1781000000000'),
(63,1782000000000,'AddIdentitySignIn1782000000000'),
(64,1782000000001,'AddIdentityLoginGuards1782000000001');
/*!40000 ALTER TABLE `migrations` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `role` WRITE;
/*!40000 ALTER TABLE `role` DISABLE KEYS */;
INSERT INTO `role` (`id`, `organizationId`, `name`, `description`, `permissions`, `createdDate`, `updatedDate`, `createdBy`, `updatedBy`) VALUES ('5d7f9123-c155-11f1-9ef8-822b383dbcd0',NULL,'owner','Has full control over the organization.','[\"organization\",\"workspace\"]','2026-10-06 07:13:01','2026-10-06 07:13:01',NULL,NULL),
('5d7fd76b-c155-11f1-9ef8-822b383dbcd0',NULL,'member','Has limited control over the organization.','[]','2026-10-06 07:13:01','2026-10-06 07:13:01',NULL,NULL),
('5d80236b-c155-11f1-9ef8-822b383dbcd0',NULL,'personal workspace','Has full control over the personal workspace','[\"chatflows:view\",\"chatflows:create\",\"chatflows:update\",\"chatflows:duplicate\",\"chatflows:delete\",\"chatflows:export\",\"chatflows:import\",\"chatflows:config\",\"chatflows:domains\",\"agentflows:view\",\"agentflows:create\",\"agentflows:update\",\"agentflows:duplicate\",\"agentflows:delete\",\"agentflows:export\",\"agentflows:import\",\"agentflows:config\",\"agentflows:domains\",\"tools:view\",\"tools:create\",\"tools:update\",\"tools:delete\",\"tools:export\",\"assistants:view\",\"assistants:create\",\"assistants:update\",\"assistants:delete\",\"credentials:view\",\"credentials:create\",\"credentials:update\",\"credentials:delete\",\"credentials:share\",\"variables:view\",\"variables:create\",\"variables:update\",\"variables:delete\",\"apikeys:view\",\"apikeys:create\",\"apikeys:update\",\"apikeys:delete\",\"documentStores:view\",\"documentStores:create\",\"documentStores:update\",\"documentStores:delete\",\"documentStores:add-loader\",\"documentStores:delete-loader\",\"documentStores:preview-process\",\"documentStores:upsert-config\",\"datasets:view\",\"datasets:create\",\"datasets:update\",\"datasets:delete\",\"evaluators:view\",\"evaluators:create\",\"evaluators:update\",\"evaluators:delete\",\"evaluations:view\",\"evaluations:create\",\"evaluations:update\",\"evaluations:delete\",\"evaluations:run\",\"templates:marketplace\",\"templates:custom\",\"templates:custom-delete\",\"templates:toolexport\",\"templates:flowexport\",\"templates:custom-share\",\"workspace:export\",\"workspace:import\",\"executions:view\",\"executions:delete\"]','2026-10-06 07:13:01','2026-10-06 07:13:01',NULL,NULL);
/*!40000 ALTER TABLE `role` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

