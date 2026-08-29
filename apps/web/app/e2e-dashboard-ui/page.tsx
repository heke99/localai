import { notFound } from "next/navigation";
import { WorkspaceShellV5 } from "../dashboard/workspace-shell-v5";

export const dynamic = "force-dynamic";

export default function DashboardUiHarnessPage() {
  if (process.env.DIV3RSA_E2E_UI_HARNESS !== "1") notFound();
  return <WorkspaceShellV5
    workspaceId="44444444-4444-4444-4444-444444444444"
    workspaceName="E2E Workspace"
    displayName="Test User"
    email="test@example.com"
    isSuperadmin={false}
    snapshot={{
      projects: [],
      conversations: [],
      integrations: [],
      available_resources: [],
      project_resources: [],
      capability_catalog: []
    }}
  />;
}
