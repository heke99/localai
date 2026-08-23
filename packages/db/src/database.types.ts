export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

type TableDef<Row extends Record<string, unknown>, Insert extends Record<string, unknown> = Partial<Row>, Update extends Record<string, unknown> = Partial<Row>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  __InternalSupabase: { PostgrestVersion: "14.15" }
  public: {
    Tables: {
      access_requests: TableDef<{
        id: string
        email: string
        name: string
        organization_name: string | null
        use_case: string
        status: Database["public"]["Enums"]["access_request_status"]
        reviewed_at: string | null
        reviewed_by: string | null
        invited_at: string | null
        invited_user_id: string | null
        organization_id: string | null
        workspace_id: string | null
        password_email_sent_at: string | null
        onboarding_completed_at: string | null
        created_at: string
      }>
      conversation_resource_selections: TableDef<{
        conversation_id: string
        resource_id: string
        selected_by: string
        selected_at: string
      }>
      conversations: TableDef<{
        id: string
        workspace_id: string
        project_id: string | null
        created_by: string
        mode: string
        title: string | null
        created_at: string
        updated_at: string
      }>
      integration_resource_grants: TableDef<{
        project_id: string
        resource_id: string
        capability: string
        granted: boolean
        granted_by: string
        created_at: string
        updated_at: string
      }>
      messages: TableDef<{
        id: string
        conversation_id: string
        actor_user_id: string | null
        role: string
        content: Json
        model_version_id: string | null
        created_at: string
      }>
      organization_members: TableDef<{
        organization_id: string
        user_id: string
        status: Database["public"]["Enums"]["membership_status"]
        joined_at: string | null
        created_at: string
      }>
      organizations: TableDef<{
        id: string
        name: string
        slug: string
        created_by: string
        created_at: string
      }>
      permissions: TableDef<{
        id: string
        key: string
        description: string
      }>
      profiles: TableDef<{
        user_id: string
        display_name: string | null
        avatar_path: string | null
        created_at: string
        updated_at: string
      }>
      project_integration_resources: TableDef<{
        project_id: string
        resource_id: string
        enabled: boolean
        created_by: string
        created_at: string
        updated_at: string
      }>
      project_repositories: TableDef<{
        id: string
        project_id: string
        provider: string
        external_repository_id: string
        default_branch: string
        installation_reference: string | null
        created_at: string
      }>
      project_resource_links: TableDef<{
        id: string
        project_id: string
        resource_a_id: string
        resource_b_id: string
        relation_key: string
        status: string
        confidence: number
        source_kind: string
        note: string | null
        created_by: string | null
        confirmed_by: string | null
        created_at: string
        updated_at: string
      }>
      projects: TableDef<{
        id: string
        workspace_id: string
        name: string
        description: string | null
        created_by: string
        created_at: string
        updated_at: string
      }>
      role_permissions: TableDef<{
        role_id: string
        permission_id: string
      }>
      roles: TableDef<{
        id: string
        organization_id: string | null
        key: string
        name: string
        system_managed: boolean
      }>
      user_roles: TableDef<{
        user_id: string
        organization_id: string
        role_id: string
        granted_by: string | null
        granted_at: string
      }>
      workspace_members: TableDef<{
        workspace_id: string
        user_id: string
        access_level: string
        created_at: string
      }>
      workspaces: TableDef<{
        id: string
        organization_id: string
        name: string
        created_by: string
        created_at: string
      }>
    }
    Views: { [_ in never]: never }
    Functions: {
      cancel_agent_run: { Args: { target_run_id: string }; Returns: boolean }
      complete_user_onboarding: { Args: never; Returns: string }
      configure_project_integration_resource: {
        Args: { target_project_id: string; target_resource_id: string; target_capabilities: string[]; target_enabled?: boolean }
        Returns: Json
      }
      conversation_resource_context: { Args: { target_conversation_id: string }; Returns: Json }
      create_conversation: {
        Args: { target_workspace_id: string; target_project_id: string | null; target_mode: string; target_title?: string | null }
        Returns: Json
      }
      create_project: {
        Args: { target_workspace_id: string; target_name: string; target_description?: string | null }
        Returns: Json
      }
      get_agent_run: {
        Args: { target_run_id: string }
        Returns: Array<{
          id: string
          status: string
          mode: string
          model_alias: string
          failure_code: string | null
          output_content: string | null
          cancel_requested_at: string | null
          created_at: string
          updated_at: string
        }>
      }
      reconcile_project_resource_links: { Args: { target_project_id: string }; Returns: number }
      remember_project_resource_link: {
        Args: { target_project_id: string; target_resource_one_id: string; target_resource_two_id: string; target_relation_key?: string; target_note?: string | null }
        Returns: Json
      }
      remove_project_resource_link: { Args: { target_link_id: string }; Returns: boolean }
      request_integration_connection: { Args: { target_workspace_id: string; target_provider: string }; Returns: Json }
      set_conversation_resources: { Args: { target_conversation_id: string; target_resource_ids: string[] }; Returns: Json }
      set_project_resource_link_status: { Args: { target_link_id: string; target_status: string }; Returns: Json }
      start_agent_run: {
        Args: {
          workspace_id: string
          conversation_id: string | null
          mode: string
          prompt: string
          request_id: string
          trace_id: string
          resource_ids?: string[]
        }
        Returns: Array<{ run_id: string; resolved_conversation_id: string }>
      }
      superadmin_begin_email_step_up: { Args: never; Returns: Json }
      superadmin_control_snapshot: { Args: never; Returns: Json }
      superadmin_create_policy_set: {
        Args: {
          target_organization_id: string | null
          target_key: string
          target_effect: string
          target_action: string
          target_resource_pattern: string
          target_conditions?: Json
        }
        Returns: string
      }
      superadmin_email_step_up_status: { Args: never; Returns: Json }
      superadmin_enqueue_operation: {
        Args: { target_queue: string; operation_payload: Json; operation_key: string }
        Returns: string
      }
      superadmin_overview: { Args: never; Returns: Json }
      superadmin_provision_access_grant: {
        Args: { target_id: string; target_user_id: string; target_slug: string }
        Returns: Json
      }
      superadmin_review_access_request: {
        Args: { target_id: string; decision: Database["public"]["Enums"]["access_request_status"] }
        Returns: boolean
      }
      superadmin_set_gpu_provider_enabled: { Args: { target_provider_id: string; target_enabled: boolean }; Returns: boolean }
      superadmin_set_membership_status: {
        Args: { target_organization_id: string; target_user_id: string; target_status: string }
        Returns: boolean
      }
      superadmin_set_model_alias: { Args: { target_alias: string; target_model_version_id: string }; Returns: boolean }
      superadmin_set_policy_status: { Args: { target_policy_set_id: string; target_status: string }; Returns: boolean }
      superadmin_verify_email_code: { Args: { code: string }; Returns: Json }
      sync_integration_connection_capabilities: {
        Args: { target_connection_id: string; target_capabilities: string[] }
        Returns: Json
      }
      sync_integration_resource: {
        Args: {
          target_connection_id: string
          target_resource_type: string
          target_external_resource_id: string
          target_display_name: string
          target_metadata?: Json
        }
        Returns: string
      }
      sync_integration_resource_identifier: {
        Args: {
          target_resource_id: string
          target_kind: string
          target_value: string
          target_source_kind?: string
          target_confidence?: number
          target_linkable?: boolean
        }
        Returns: string
      }
      worker_authorize_tool_call: {
        Args: { target_run_id: string; target_resource_id: string; target_capability: string }
        Returns: Json
      }
      worker_claim_agent_run: {
        Args: { worker_id: string }
        Returns: Array<{
          job_id: string
          run_id: string
          conversation_id: string
          organization_id: string
          requested_by: string
          request_id: string
          trace_id: string
          model_alias: string
          mode: string
          prompt: string
          resource_context: Json
        }>
      }
      worker_complete_agent_run: {
        Args: { target_run_id: string; target_job_id: string; output_content: string; model_version?: string; usage?: Json }
        Returns: undefined
      }
      worker_fail_agent_run: {
        Args: { target_run_id: string; target_job_id: string; error_code: string; retryable?: boolean }
        Returns: undefined
      }
      worker_is_agent_run_cancelled: { Args: { target_run_id: string }; Returns: boolean }
      worker_project_resource_directory: { Args: { target_run_id: string }; Returns: Json }
      worker_record_agent_step: {
        Args: { target_run_id: string; step_kind: string; step_status: string; summary: string; state?: Json }
        Returns: number
      }
      worker_remember_resource_link: {
        Args: {
          target_run_id: string
          target_resource_one_id: string
          target_resource_two_id: string
          target_relation_key?: string
          target_note?: string | null
        }
        Returns: Json
      }
      workspace_dashboard_snapshot: { Args: { target_workspace_id: string }; Returns: Json }
    }
    Enums: {
      access_request_status: "pending" | "reviewing" | "approved" | "rejected"
      membership_status: "invited" | "active" | "suspended"
    }
    CompositeTypes: { [_ in never]: never }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">
type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"]) | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends { Row: infer R } ? R : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends { Row: infer R } ? R : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends { Insert: infer I } ? I : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends { Insert: infer I } ? I : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends { Update: infer U } ? U : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends { Update: infer U } ? U : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"] ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions] : never

export const Constants = {
  public: {
    Enums: {
      access_request_status: ["pending", "reviewing", "approved", "rejected"],
      membership_status: ["invited", "active", "suspended"]
    }
  }
} as const
