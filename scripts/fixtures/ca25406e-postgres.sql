--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: apikey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apikey (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "apiKey" character varying NOT NULL,
    "apiSecret" character varying NOT NULL,
    "keyName" character varying NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: assistant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    credential uuid NOT NULL,
    details text NOT NULL,
    "iconSrc" character varying,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid,
    type text
);


--
-- Name: chat_flow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_flow (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "flowData" text NOT NULL,
    deployed boolean,
    "isPublic" boolean,
    apikeyid character varying,
    "chatbotConfig" text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "apiConfig" text,
    analytic text,
    category text,
    "speechToText" text,
    type character varying(20) DEFAULT 'CHATFLOW'::text NOT NULL,
    "workspaceId" uuid,
    "followUpPrompts" text,
    "textToSpeech" text,
    "mcpServerConfig" text,
    "webhookSecret" text,
    "webhookSecretConfigured" boolean DEFAULT false
);


--
-- Name: chat_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_message (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    role character varying NOT NULL,
    chatflowid uuid NOT NULL,
    content text NOT NULL,
    "sourceDocuments" text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "chatType" character varying DEFAULT 'INTERNAL'::character varying NOT NULL,
    "chatId" character varying NOT NULL,
    "memoryType" character varying,
    "sessionId" character varying,
    "usedTools" text,
    "fileAnnotations" text,
    "fileUploads" text,
    "leadEmail" text,
    "agentReasoning" text,
    action text,
    artifacts text,
    "followUpPrompts" text,
    "executionId" uuid,
    "reasonContent" text,
    "harnessPayload" text
);


--
-- Name: chat_message_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_message_feedback (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    chatflowid uuid NOT NULL,
    content text,
    "chatId" character varying NOT NULL,
    "messageId" uuid NOT NULL,
    rating character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "credentialName" character varying NOT NULL,
    "encryptedData" text NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: custom_mcp_server; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_mcp_server (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "serverUrl" text NOT NULL,
    "iconSrc" character varying,
    color character varying,
    "authType" character varying DEFAULT 'NONE'::character varying NOT NULL,
    "authConfig" text,
    tools text,
    "toolCount" integer DEFAULT 0 NOT NULL,
    status character varying DEFAULT 'PENDING'::character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" text NOT NULL
);


--
-- Name: custom_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_template (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "flowData" text NOT NULL,
    description character varying,
    badge character varying,
    framework character varying,
    usecases character varying,
    type character varying,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: dataset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dataset (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description character varying,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: dataset_row; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dataset_row (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "datasetId" character varying NOT NULL,
    input text NOT NULL,
    output text,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    sequence_no integer DEFAULT '-1'::integer
);


--
-- Name: identity_bootstrap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_bootstrap (
    id integer NOT NULL
);


--
-- Name: identity_local_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_local_session (
    id character varying(255) NOT NULL,
    "userId" character varying(255) NOT NULL,
    token character varying(255) NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    "absoluteExpiresAt" timestamp without time zone NOT NULL,
    "createdDate" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: identity_login_failure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_login_failure (
    id character varying(255) NOT NULL,
    scope character varying(32) NOT NULL,
    subject character varying(255) NOT NULL,
    "attemptedAt" bigint NOT NULL
);


--
-- Name: document_store; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_store (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description character varying,
    loaders text,
    "whereUsed" text,
    status character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "vectorStoreConfig" text,
    "embeddingConfig" text,
    "recordManagerConfig" text,
    "workspaceId" uuid
);


--
-- Name: document_store_file_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_store_file_chunk (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "docId" uuid NOT NULL,
    "chunkNo" integer NOT NULL,
    "storeId" uuid NOT NULL,
    "pageContent" text,
    metadata text
);


--
-- Name: evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "chatflowId" text NOT NULL,
    "chatflowName" text NOT NULL,
    "datasetId" character varying NOT NULL,
    "datasetName" character varying NOT NULL,
    "additionalConfig" text,
    "evaluationType" character varying NOT NULL,
    status character varying NOT NULL,
    average_metrics text,
    "runDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: evaluation_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluation_run (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "evaluationId" character varying NOT NULL,
    input text NOT NULL,
    "expectedOutput" text,
    "actualOutput" text,
    evaluators text,
    "llmEvaluators" text,
    metrics text,
    "runDate" timestamp without time zone DEFAULT now() NOT NULL,
    errors text DEFAULT '[]'::text
);


--
-- Name: evaluator; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evaluator (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    type text,
    config text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: execution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "executionData" text NOT NULL,
    action text,
    state character varying NOT NULL,
    "agentflowId" uuid NOT NULL,
    "sessionId" character varying NOT NULL,
    "isPublic" boolean,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "stoppedDate" timestamp without time zone,
    "workspaceId" uuid
);


--
-- Name: lead; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    chatflowid character varying NOT NULL,
    "chatId" character varying NOT NULL,
    name text,
    email text,
    phone text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: login_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_activity (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    username character varying NOT NULL,
    activity_code integer NOT NULL,
    message character varying NOT NULL,
    "attemptedDateTime" timestamp without time zone DEFAULT now() NOT NULL,
    login_mode character varying
);


--
-- Name: login_method; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_method (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "organizationId" uuid,
    name character varying(100) NOT NULL,
    config text NOT NULL,
    status character varying(20) DEFAULT 'enable'::character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid,
    "updatedBy" uuid
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) DEFAULT 'Default Organization'::character varying NOT NULL,
    "customerId" character varying(100),
    "subscriptionId" character varying(100),
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid NOT NULL,
    "updatedBy" uuid NOT NULL
);


--
-- Name: organization_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_user (
    "organizationId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "roleId" uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid NOT NULL,
    "updatedBy" uuid NOT NULL
);


--
-- Name: role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "organizationId" uuid,
    name character varying(100) NOT NULL,
    description text,
    permissions text NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid,
    "updatedBy" uuid
);


--
-- Name: schedule_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_record (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "triggerType" character varying(32) NOT NULL,
    "targetId" character varying NOT NULL,
    "nodeId" text,
    "cronExpression" text NOT NULL,
    timezone character varying(64) DEFAULT 'UTC'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "scheduleInputMode" character varying(16) NOT NULL,
    "defaultInput" text,
    "defaultForm" text,
    "lastRunAt" timestamp without time zone,
    "nextRunAt" timestamp without time zone,
    "endDate" timestamp without time zone,
    "workspaceId" character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: schedule_trigger_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_trigger_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "scheduleRecordId" character varying NOT NULL,
    "triggerType" character varying(32) NOT NULL,
    "targetId" character varying NOT NULL,
    "executionId" character varying,
    status character varying(32) NOT NULL,
    error text,
    "elapsedTimeMs" integer,
    "scheduledAt" timestamp without time zone NOT NULL,
    "workspaceId" character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description text NOT NULL,
    color character varying NOT NULL,
    "iconSrc" character varying,
    schema text,
    func text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: upsert_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upsert_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    chatflowid character varying NOT NULL,
    result text NOT NULL,
    "flowData" text NOT NULL,
    date timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    credential text,
    "tempToken" text,
    "tokenExpiry" timestamp without time zone,
    status character varying(20) DEFAULT 'unverified'::character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid NOT NULL,
    "updatedBy" uuid NOT NULL,
    "ssoProvider" character varying,
    "ssoSubjectId" character varying,
    "externalId" character varying(255)
);


--
-- Name: variable; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variable (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    value text NOT NULL,
    type text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "workspaceId" uuid
);


--
-- Name: workspace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "organizationId" uuid NOT NULL,
    "createdBy" uuid NOT NULL,
    "updatedBy" uuid NOT NULL
);


--
-- Name: workspace_shared; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_shared (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "workspaceId" uuid NOT NULL,
    "sharedItemId" character varying NOT NULL,
    "itemType" character varying NOT NULL,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_user (
    "workspaceId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "roleId" uuid NOT NULL,
    status character varying(20) DEFAULT 'invited'::character varying NOT NULL,
    "lastLogin" timestamp without time zone,
    "createdDate" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedDate" timestamp without time zone DEFAULT now() NOT NULL,
    "createdBy" uuid NOT NULL,
    "updatedBy" uuid NOT NULL
);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: upsert_history PK_37327b22b6e246319bd5eeb0e88; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upsert_history
    ADD CONSTRAINT "PK_37327b22b6e246319bd5eeb0e88" PRIMARY KEY (id);


--
-- Name: credential PK_3a5169bcd3d5463cefeec78be82; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential
    ADD CONSTRAINT "PK_3a5169bcd3d5463cefeec78be82" PRIMARY KEY (id);


--
-- Name: tool PK_3bf5b1016a384916073184f99b7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool
    ADD CONSTRAINT "PK_3bf5b1016a384916073184f99b7" PRIMARY KEY (id);


--
-- Name: assistant PK_3c7cea7a044ac4c92764576cdbf; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant
    ADD CONSTRAINT "PK_3c7cea7a044ac4c92764576cdbf" PRIMARY KEY (id);


--
-- Name: chat_flow PK_3c7cea7d047ac4b91764574cdbf; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_flow
    ADD CONSTRAINT "PK_3c7cea7d047ac4b91764574cdbf" PRIMARY KEY (id);


--
-- Name: custom_template PK_3c7cea7d087ac4b91764574cdbf; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_template
    ADD CONSTRAINT "PK_3c7cea7d087ac4b91764574cdbf" PRIMARY KEY (id);


--
-- Name: chat_message PK_3cc0d85193aade457d3077dd06b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message
    ADD CONSTRAINT "PK_3cc0d85193aade457d3077dd06b" PRIMARY KEY (id);


--
-- Name: migrations PK_8c82d7f526340ab734260ea46be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);


--
-- Name: document_store_file_chunk PK_90005043dd774f54-9830ab78f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_store_file_chunk
    ADD CONSTRAINT "PK_90005043dd774f54-9830ab78f9" PRIMARY KEY (id);


--
-- Name: workspace_shared PK_90016043dd804f55-9830ab97f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_shared
    ADD CONSTRAINT "PK_90016043dd804f55-9830ab97f8" PRIMARY KEY (id);


--
-- Name: evaluator PK_90019043dd804f54-9830ab11f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluator
    ADD CONSTRAINT "PK_90019043dd804f54-9830ab11f8" PRIMARY KEY (id);


--
-- Name: execution PK_936a419c3b8044598d72d95da61; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution
    ADD CONSTRAINT "PK_936a419c3b8044598d72d95da61" PRIMARY KEY (id);


--
-- Name: apikey PK_96109043dd704f53-9830ab78f0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apikey
    ADD CONSTRAINT "PK_96109043dd704f53-9830ab78f0" PRIMARY KEY (id);


--
-- Name: lead PK_98419043dd704f54-9830ab78f0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead
    ADD CONSTRAINT "PK_98419043dd704f54-9830ab78f0" PRIMARY KEY (id);


--
-- Name: variable PK_98419043dd704f54-9830ab78f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variable
    ADD CONSTRAINT "PK_98419043dd704f54-9830ab78f8" PRIMARY KEY (id);


--
-- Name: chat_message_feedback PK_98419043dd704f54-9830ab78f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_feedback
    ADD CONSTRAINT "PK_98419043dd704f54-9830ab78f9" PRIMARY KEY (id);


--
-- Name: dataset PK_98419043dd804f54-9830ab99f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dataset
    ADD CONSTRAINT "PK_98419043dd804f54-9830ab99f8" PRIMARY KEY (id);


--
-- Name: document_store PK_98495043dd774f54-9830ab78f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_store
    ADD CONSTRAINT "PK_98495043dd774f54-9830ab78f9" PRIMARY KEY (id);


--
-- Name: workspace PK_98719043dd804f55-9830ab99f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT "PK_98719043dd804f55-9830ab99f8" PRIMARY KEY (id);


--
-- Name: dataset_row PK_98909027dd804f54-9840ab99f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dataset_row
    ADD CONSTRAINT "PK_98909027dd804f54-9840ab99f8" PRIMARY KEY (id);


--
-- Name: evaluation PK_98989043dd804f54-9830ab99f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation
    ADD CONSTRAINT "PK_98989043dd804f54-9830ab99f8" PRIMARY KEY (id);


--
-- Name: evaluation_run PK_98989927dd804f54-9840ab23f8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation_run
    ADD CONSTRAINT "PK_98989927dd804f54-9840ab23f8" PRIMARY KEY (id);


--
-- Name: custom_mcp_server PK_custom_mcp_server_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_mcp_server
    ADD CONSTRAINT "PK_custom_mcp_server_id" PRIMARY KEY (id);


--
-- Name: schedule_record PK_schedule_record; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_record
    ADD CONSTRAINT "PK_schedule_record" PRIMARY KEY (id);


--
-- Name: schedule_trigger_log PK_schedule_trigger_log; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_trigger_log
    ADD CONSTRAINT "PK_schedule_trigger_log" PRIMARY KEY (id);


--
-- Name: chat_message_feedback UQ_6352078b5a294f2d22179ea7956; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_feedback
    ADD CONSTRAINT "UQ_6352078b5a294f2d22179ea7956" UNIQUE ("messageId");


--
-- Name: identity_bootstrap identity_bootstrap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_bootstrap
    ADD CONSTRAINT identity_bootstrap_pkey PRIMARY KEY (id);


--
-- Name: identity_local_session identity_local_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_local_session
    ADD CONSTRAINT identity_local_session_pkey PRIMARY KEY (id);


--
-- Name: identity_login_failure identity_login_failure_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_login_failure
    ADD CONSTRAINT identity_login_failure_pkey PRIMARY KEY (id);


--
-- Name: login_method login_method_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_method
    ADD CONSTRAINT login_method_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization_user pk_organization_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT pk_organization_user PRIMARY KEY ("organizationId", "userId");


--
-- Name: workspace_user pk_workspace_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT pk_workspace_user PRIMARY KEY ("workspaceId", "userId");


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: IDX_9acddcb7a2b51fe37669049fc6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9acddcb7a2b51fe37669049fc6" ON public.chat_message_feedback USING btree ("chatId");


--
-- Name: IDX_chatflow_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_chatflow_name" ON public.chat_flow USING btree (SUBSTRING(name FROM 1 FOR 255));


--
-- Name: IDX_custom_mcp_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_custom_mcp_workspace_updated" ON public.custom_mcp_server USING btree ("workspaceId", "updatedDate");


--
-- Name: IDX_identity_local_session_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_identity_local_session_token" ON public.identity_local_session USING btree (token);


--
-- Name: IDX_identity_login_failure_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_identity_login_failure_lookup" ON public.identity_login_failure USING btree (scope, subject, "attemptedAt");


--
-- Name: IDX_e213b811b01405a42309a6a410; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e213b811b01405a42309a6a410" ON public.document_store_file_chunk USING btree ("storeId");


--
-- Name: IDX_e574527322272fd838f4f0f3d3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e574527322272fd838f4f0f3d3" ON public.chat_message USING btree (chatflowid);


--
-- Name: IDX_e76bae1780b77e56aab1h2asd4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e76bae1780b77e56aab1h2asd4" ON public.document_store_file_chunk USING btree ("docId");


--
-- Name: IDX_f56c36fe42894d57e5c664d229; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f56c36fe42894d57e5c664d229" ON public.chat_message USING btree (chatflowid);


--
-- Name: IDX_f56c36fe42894d57e5c664d230; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f56c36fe42894d57e5c664d230" ON public.chat_message_feedback USING btree (chatflowid);


--
-- Name: IDX_schedule_record_targetId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_schedule_record_targetId" ON public.schedule_record USING btree ("targetId");


--
-- Name: IDX_schedule_trigger_log_scheduleRecordId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_schedule_trigger_log_scheduleRecordId" ON public.schedule_trigger_log USING btree ("scheduleRecordId");


--
-- Name: IDX_schedule_trigger_log_targetId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_schedule_trigger_log_targetId" ON public.schedule_trigger_log USING btree ("targetId");


--
-- Name: IDX_user_externalId; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_user_externalId" ON public."user" USING btree ("externalId");


--
-- Name: idx_apikey_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_apikey_workspaceId" ON public.apikey USING btree ("workspaceId");


--
-- Name: idx_assistant_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_assistant_workspaceId" ON public.assistant USING btree ("workspaceId");


--
-- Name: idx_chat_flow_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_chat_flow_workspaceId" ON public.chat_flow USING btree ("workspaceId");


--
-- Name: idx_credential_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_credential_workspaceId" ON public.credential USING btree ("workspaceId");


--
-- Name: idx_custom_template_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_custom_template_workspaceId" ON public.custom_template USING btree ("workspaceId");


--
-- Name: idx_dataset_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_dataset_workspaceId" ON public.dataset USING btree ("workspaceId");


--
-- Name: idx_document_store_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_document_store_workspaceId" ON public.document_store USING btree ("workspaceId");


--
-- Name: idx_evaluation_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_evaluation_workspaceId" ON public.evaluation USING btree ("workspaceId");


--
-- Name: idx_evaluator_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_evaluator_workspaceId" ON public.evaluator USING btree ("workspaceId");


--
-- Name: idx_execution_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_execution_workspaceId" ON public.execution USING btree ("workspaceId");


--
-- Name: idx_tool_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_tool_workspaceId" ON public.tool USING btree ("workspaceId");


--
-- Name: idx_variable_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_variable_workspaceId" ON public.variable USING btree ("workspaceId");


--
-- Name: idx_workspace_shared_workspaceId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workspace_shared_workspaceId" ON public.workspace_shared USING btree ("workspaceId");


--
-- Name: apikey fk_apikey_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apikey
    ADD CONSTRAINT "fk_apikey_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: assistant fk_assistant_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant
    ADD CONSTRAINT "fk_assistant_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: chat_flow fk_chat_flow_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_flow
    ADD CONSTRAINT "fk_chat_flow_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: login_method fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_method
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: organization fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: organization_user fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: role fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: user fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: workspace fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: workspace_user fk_createdBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT "fk_createdBy" FOREIGN KEY ("createdBy") REFERENCES public."user"(id);


--
-- Name: credential fk_credential_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential
    ADD CONSTRAINT "fk_credential_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: custom_template fk_custom_template_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_template
    ADD CONSTRAINT "fk_custom_template_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: dataset fk_dataset_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dataset
    ADD CONSTRAINT "fk_dataset_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: document_store fk_document_store_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_store
    ADD CONSTRAINT "fk_document_store_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: evaluation fk_evaluation_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluation
    ADD CONSTRAINT "fk_evaluation_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: evaluator fk_evaluator_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evaluator
    ADD CONSTRAINT "fk_evaluator_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: execution fk_execution_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution
    ADD CONSTRAINT "fk_execution_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: login_method fk_organizationId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_method
    ADD CONSTRAINT "fk_organizationId" FOREIGN KEY ("organizationId") REFERENCES public.organization(id);


--
-- Name: organization_user fk_organizationId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "fk_organizationId" FOREIGN KEY ("organizationId") REFERENCES public.organization(id);


--
-- Name: role fk_organizationId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT "fk_organizationId" FOREIGN KEY ("organizationId") REFERENCES public.organization(id);


--
-- Name: workspace fk_organizationId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT "fk_organizationId" FOREIGN KEY ("organizationId") REFERENCES public.organization(id);


--
-- Name: organization_user fk_roleId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "fk_roleId" FOREIGN KEY ("roleId") REFERENCES public.role(id);


--
-- Name: workspace_user fk_roleId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT "fk_roleId" FOREIGN KEY ("roleId") REFERENCES public.role(id);


--
-- Name: tool fk_tool_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool
    ADD CONSTRAINT "fk_tool_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: login_method fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_method
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: organization fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: organization_user fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: role fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: user fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: workspace fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: workspace_user fk_updatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT "fk_updatedBy" FOREIGN KEY ("updatedBy") REFERENCES public."user"(id);


--
-- Name: organization_user fk_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_user
    ADD CONSTRAINT "fk_userId" FOREIGN KEY ("userId") REFERENCES public."user"(id);


--
-- Name: workspace_user fk_userId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT "fk_userId" FOREIGN KEY ("userId") REFERENCES public."user"(id);


--
-- Name: variable fk_variable_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variable
    ADD CONSTRAINT "fk_variable_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: workspace_user fk_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_user
    ADD CONSTRAINT "fk_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- Name: workspace_shared fk_workspace_shared_workspaceId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_shared
    ADD CONSTRAINT "fk_workspace_shared_workspaceId" FOREIGN KEY ("workspaceId") REFERENCES public.workspace(id);


--
-- PostgreSQL database dump complete
--


--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.migrations VALUES (1, 1693891895163, 'Init1693891895163');
INSERT INTO public.migrations VALUES (2, 1693995626941, 'ModifyChatFlow1693995626941');
INSERT INTO public.migrations VALUES (3, 1693996694528, 'ModifyChatMessage1693996694528');
INSERT INTO public.migrations VALUES (4, 1693997070000, 'ModifyCredential1693997070000');
INSERT INTO public.migrations VALUES (5, 1693997339912, 'ModifyTool1693997339912');
INSERT INTO public.migrations VALUES (6, 1694099183389, 'AddApiConfig1694099183389');
INSERT INTO public.migrations VALUES (7, 1694432361423, 'AddAnalytic1694432361423');
INSERT INTO public.migrations VALUES (8, 1694658756136, 'AddChatHistory1694658756136');
INSERT INTO public.migrations VALUES (9, 1699325775451, 'AddAssistantEntity1699325775451');
INSERT INTO public.migrations VALUES (10, 1699325775451, 'AddVariableEntity1699325775451');
INSERT INTO public.migrations VALUES (11, 1699481607341, 'AddUsedToolsToChatMessage1699481607341');
INSERT INTO public.migrations VALUES (12, 1699900910291, 'AddCategoryToChatFlow1699900910291');
INSERT INTO public.migrations VALUES (13, 1700271021237, 'AddFileAnnotationsToChatMessage1700271021237');
INSERT INTO public.migrations VALUES (14, 1701788586491, 'AddFileUploadsToChatMessage1701788586491');
INSERT INTO public.migrations VALUES (15, 1706364937060, 'AddSpeechToText1706364937060');
INSERT INTO public.migrations VALUES (16, 1707213601923, 'AddFeedback1707213601923');
INSERT INTO public.migrations VALUES (17, 1709814301358, 'AddUpsertHistoryEntity1709814301358');
INSERT INTO public.migrations VALUES (18, 1710497452584, 'FieldTypes1710497452584');
INSERT INTO public.migrations VALUES (19, 1710832137905, 'AddLead1710832137905');
INSERT INTO public.migrations VALUES (20, 1711538016098, 'AddLeadToChatMessage1711538016098');
INSERT INTO public.migrations VALUES (21, 1711637331047, 'AddDocumentStore1711637331047');
INSERT INTO public.migrations VALUES (22, 1714548873039, 'AddEvaluation1714548873039');
INSERT INTO public.migrations VALUES (23, 1714548903384, 'AddDatasets1714548903384');
INSERT INTO public.migrations VALUES (24, 1714679514451, 'AddAgentReasoningToChatMessage1714679514451');
INSERT INTO public.migrations VALUES (25, 1714808591644, 'AddEvaluator1714808591644');
INSERT INTO public.migrations VALUES (26, 1715861032479, 'AddVectorStoreConfigToDocStore1715861032479');
INSERT INTO public.migrations VALUES (27, 1716300000000, 'AddTypeToChatFlow1716300000000');
INSERT INTO public.migrations VALUES (28, 1720230151480, 'AddApiKey1720230151480');
INSERT INTO public.migrations VALUES (29, 1720230151482, 'AddAuthTables1720230151482');
INSERT INTO public.migrations VALUES (30, 1720230151484, 'AddWorkspace1720230151484');
INSERT INTO public.migrations VALUES (31, 1721078251523, 'AddActionToChatMessage1721078251523');
INSERT INTO public.migrations VALUES (32, 1725629836652, 'AddCustomTemplate1725629836652');
INSERT INTO public.migrations VALUES (33, 1726156258465, 'AddArtifactsToChatMessage1726156258465');
INSERT INTO public.migrations VALUES (34, 1726654922034, 'AddWorkspaceShared1726654922034');
INSERT INTO public.migrations VALUES (35, 1726655750383, 'AddWorkspaceIdToCustomTemplate1726655750383');
INSERT INTO public.migrations VALUES (36, 1726666309552, 'AddFollowUpPrompts1726666309552');
INSERT INTO public.migrations VALUES (37, 1727798417345, 'AddOrganization1727798417345');
INSERT INTO public.migrations VALUES (38, 1729130948686, 'LinkWorkspaceId1729130948686');
INSERT INTO public.migrations VALUES (39, 1729133111652, 'LinkOrganizationId1729133111652');
INSERT INTO public.migrations VALUES (40, 1730519457880, 'AddSSOColumns1730519457880');
INSERT INTO public.migrations VALUES (41, 1733011290987, 'AddTypeToAssistant1733011290987');
INSERT INTO public.migrations VALUES (42, 1733752119696, 'AddSeqNoToDatasetRow1733752119696');
INSERT INTO public.migrations VALUES (43, 1734074497540, 'AddPersonalWorkspace1734074497540');
INSERT INTO public.migrations VALUES (44, 1737076223692, 'RefactorEnterpriseDatabase1737076223692');
INSERT INTO public.migrations VALUES (45, 1738090872625, 'AddExecutionEntity1738090872625');
INSERT INTO public.migrations VALUES (46, 1743758056188, 'FixOpenSourceAssistantTable1743758056188');
INSERT INTO public.migrations VALUES (47, 1744964560174, 'AddErrorToEvaluationRun1744964560174');
INSERT INTO public.migrations VALUES (48, 1746862866554, 'ExecutionLinkWorkspaceId1746862866554');
INSERT INTO public.migrations VALUES (49, 1748450230238, 'ModifyExecutionSessionIdFieldType1748450230238');
INSERT INTO public.migrations VALUES (50, 1754986480347, 'AddTextToSpeechToChatFlow1754986480347');
INSERT INTO public.migrations VALUES (51, 1755066758601, 'ModifyChatflowType1755066758601');
INSERT INTO public.migrations VALUES (52, 1759419194331, 'AddTextToSpeechToChatFlow1759419194331');
INSERT INTO public.migrations VALUES (53, 1759424903973, 'AddChatFlowNameIndex1759424903973');
INSERT INTO public.migrations VALUES (54, 1764759496768, 'AddReasonContentToChatMessage1764759496768');
INSERT INTO public.migrations VALUES (55, 1765360298674, 'AddApiKeyPermission1765360298674');
INSERT INTO public.migrations VALUES (56, 1766000000000, 'AddCustomMcpServer1766000000000');
INSERT INTO public.migrations VALUES (57, 1767000000000, 'AddMcpServerConfigToChatFlow1767000000000');
INSERT INTO public.migrations VALUES (58, 1772000000000, 'AddScheduleEntities1772000000000');
INSERT INTO public.migrations VALUES (59, 1776240000001, 'AddWebhookSecretToChatFlow1776240000001');
INSERT INTO public.migrations VALUES (60, 1780000000000, 'AddSSOIdentityBinding1780000000000');
INSERT INTO public.migrations VALUES (61, 1781000000000, 'AddHarnessPayloadToChatMessage1781000000000');
INSERT INTO public.migrations VALUES (62, 1782000000000, 'AddIdentitySignIn1782000000000');
INSERT INTO public.migrations VALUES (63, 1782000000001, 'AddIdentityLoginGuards1782000000001');


--
-- Data for Name: role; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.role VALUES ('4f069eb1-2552-4b2e-84b0-4ec986bc6e47', NULL, 'owner', 'Has full control over the organization.', '["organization","workspace"]', '2026-10-06 07:12:58.209709', '2026-10-06 07:12:58.209709', NULL, NULL);
INSERT INTO public.role VALUES ('b751b2cc-b9f7-4bb4-b611-d03c99711eeb', NULL, 'member', 'Has limited control over the organization.', '[]', '2026-10-06 07:12:58.209709', '2026-10-06 07:12:58.209709', NULL, NULL);
INSERT INTO public.role VALUES ('8a659c27-c39a-4c9f-bece-cd495ee133ef', NULL, 'personal workspace', 'Has full control over the personal workspace', '["chatflows:view","chatflows:create","chatflows:update","chatflows:duplicate","chatflows:delete","chatflows:export","chatflows:import","chatflows:config","chatflows:domains","agentflows:view","agentflows:create","agentflows:update","agentflows:duplicate","agentflows:delete","agentflows:export","agentflows:import","agentflows:config","agentflows:domains","tools:view","tools:create","tools:update","tools:delete","tools:export","assistants:view","assistants:create","assistants:update","assistants:delete","credentials:view","credentials:create","credentials:update","credentials:delete","credentials:share","variables:view","variables:create","variables:update","variables:delete","apikeys:view","apikeys:create","apikeys:update","apikeys:delete","documentStores:view","documentStores:create","documentStores:update","documentStores:delete","documentStores:add-loader","documentStores:delete-loader","documentStores:preview-process","documentStores:upsert-config","datasets:view","datasets:create","datasets:update","datasets:delete","evaluators:view","evaluators:create","evaluators:update","evaluators:delete","evaluations:view","evaluations:create","evaluations:update","evaluations:delete","evaluations:run","templates:marketplace","templates:custom","templates:custom-delete","templates:toolexport","templates:flowexport","templates:custom-share","workspace:export","workspace:import","executions:view","executions:delete"]', '2026-10-06 07:12:58.209709', '2026-10-06 07:12:58.209709', NULL, NULL);


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 63, true);


--
-- PostgreSQL database dump complete
--


