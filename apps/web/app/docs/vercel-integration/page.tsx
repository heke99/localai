import type { Metadata } from "next";
import { PublicInfoLayout } from "../../public-info";
import styles from "../../public-info.module.css";

export const metadata: Metadata = {
  title: "Vercel Integration Documentation | DIV3RSA",
  description: "How to connect Vercel to DIV3RSA, authorize projects, receive deployment webhooks and use deployment and runtime logs."
};

export default function VercelIntegrationDocs() {
  return <PublicInfoLayout
    eyebrow="Integration documentation"
    title="Vercel integration"
    intro="Connect selected Vercel projects to DIV3RSA so the platform can inspect deployments, read build and runtime logs, trigger authorized deployments and react to signed Vercel deployment events."
  >
    <section>
      <h2>Overview</h2>
      <p>DIV3RSA uses a Vercel External / Connectable Integration. A Vercel account owner explicitly chooses the Vercel team and projects that the integration may access. DIV3RSA does not treat a Vercel identity login by itself as project authorization.</p>
      <div className={styles.callout}><strong>Authorization model:</strong> the connection is considered usable only after Vercel returns an installation configuration and DIV3RSA can read at least one project selected by the user.</div>
    </section>

    <section>
      <h2>Installation</h2>
      <ol>
        <li>Sign in to DIV3RSA and open <strong>Integrations</strong>.</li>
        <li>Select <strong>Connect</strong> for Vercel.</li>
        <li>You are redirected to Vercel's installation flow.</li>
        <li>Select the Vercel account or team and the projects you want to authorize.</li>
        <li>Review the requested permissions and approve the installation.</li>
        <li>Vercel redirects back to DIV3RSA. DIV3RSA exchanges the authorization code for an installation token and verifies the selected projects.</li>
      </ol>
      <p>The production callback used by the integration is <code>https://system.div3rsa.com/api/integrations/vercel/callback</code>.</p>
    </section>

    <section>
      <h2>Requested access</h2>
      <p>DIV3RSA requests only access required by the Vercel features currently exposed by the platform. The exact labels shown by Vercel may change over time.</p>
      <table className={styles.table}>
        <thead><tr><th>Area</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>User · Read</td><td>Display the connected Vercel identity when available.</td></tr>
          <tr><td>Team · Read</td><td>Resolve the team selected during installation and scope API requests correctly.</td></tr>
          <tr><td>Project · Read</td><td>Discover the projects explicitly made available to the integration.</td></tr>
          <tr><td>Deployment · Read</td><td>List deployments, inspect deployment state and retrieve deployment-related diagnostics.</td></tr>
          <tr><td>Deployment · Write</td><td>Create or roll back a deployment when an authorized DIV3RSA user explicitly invokes the corresponding action.</td></tr>
        </tbody>
      </table>
      <p>DIV3RSA does not request domain or environment-variable write access as part of the current Vercel integration.</p>
    </section>

    <section>
      <h2>Webhooks and deployment events</h2>
      <p>Vercel sends signed HTTPS POST requests to <code>https://system.div3rsa.com/api/integrations/vercel/webhook</code>. DIV3RSA verifies the <code>x-vercel-signature</code> header using the integration secret before accepting an event.</p>
      <p>The integration can process deployment lifecycle events including created, build requested, error, blocked, canceled, succeeded, promoted, rollback and ready events. It can also process selected project and integration-configuration events so project access stays synchronized when the Vercel installation changes.</p>
      <p>Webhook events are de-duplicated by the Vercel event identifier. DIV3RSA stores operational event metadata such as project ID, deployment ID, state, target, branch/commit metadata and event time. It does not use the webhook as a bulk log-ingestion channel.</p>
    </section>

    <section>
      <h2>Deployment and runtime logs</h2>
      <p>When an authorized user asks DIV3RSA to investigate a deployment, the platform uses the stored Vercel project and deployment identifiers to request current deployment information and logs from Vercel. This enables workflows such as detecting a failed deployment, retrieving the relevant build/runtime output and presenting the failure context to the user.</p>
      <p>Log access is performed server-side with the Vercel installation credential associated with that DIV3RSA connection. Credentials are not exposed to the browser or returned to the model as plain text.</p>
    </section>

    <section>
      <h2>Security model</h2>
      <ul>
        <li>OAuth state is bound to the authenticated DIV3RSA integration session.</li>
        <li>A Vercel installation configuration and readable project scope are required before the connection becomes active.</li>
        <li>Vercel credentials are stored server-side and protected from normal user access.</li>
        <li>Webhook signatures are verified before payload processing.</li>
        <li>Webhook deliveries are idempotent to protect against duplicate retries.</li>
        <li>Project-scoped authorization is enforced before deployment actions or log access are executed.</li>
        <li>DIV3RSA maintains audit and execution controls around privileged integration actions.</li>
      </ul>
    </section>

    <section>
      <h2>Changing project access</h2>
      <p>If you add or remove Vercel projects from the installation, Vercel may send integration configuration or project connection events. DIV3RSA uses these events to refresh the projects and capabilities associated with the connection. A project removed from the Vercel installation must no longer be treated as an authorized DIV3RSA resource.</p>
    </section>

    <section>
      <h2>Disconnecting Vercel</h2>
      <p>You can disconnect the integration from DIV3RSA. Disconnecting revokes the DIV3RSA-side connection, removes discovered project bindings and invalidates outstanding integration execution grants. You may also uninstall or change the integration directly in Vercel. For complete revocation, remove the installation in Vercel as well.</p>
    </section>

    <section>
      <h2>Troubleshooting</h2>
      <h3>No projects appear after authorization</h3>
      <p>Confirm that at least one project was selected in the Vercel installation and that Project Read access was granted. DIV3RSA intentionally rejects identity-only connections with zero readable projects.</p>
      <h3>Deployment or log access returns permission denied</h3>
      <p>Review the Vercel installation scopes and confirm that the affected project is still included. Reconnect the integration if Vercel requires a permission upgrade.</p>
      <h3>Webhook deliveries fail</h3>
      <p>Confirm that the configured webhook URL is <code>https://system.div3rsa.com/api/integrations/vercel/webhook</code>, that HTTPS is used and that the integration secret configured in DIV3RSA matches the Vercel integration.</p>
    </section>

    <section>
      <h2>Support</h2>
      <p>For integration support, visit <a href="/support">DIV3RSA Support</a> or email <a href="mailto:info@div3rsa.com">info@div3rsa.com</a>. Include the affected DIV3RSA workspace, Vercel team/project name and deployment ID where relevant. Do not send access tokens or client secrets by email.</p>
    </section>
  </PublicInfoLayout>;
}
