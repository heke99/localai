import type { Metadata } from "next";
import { PublicInfoLayout } from "../../public-info";
import styles from "../../public-info.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | DIV3RSA",
  description: "Privacy Policy for DIV3RSA, including connected integrations such as Vercel."
};

export default function PrivacyPage() {
  return <PublicInfoLayout
    eyebrow="Privacy"
    title="Privacy Policy"
    intro="This policy explains how DIV3RSA processes personal data when you visit the service, create an account, apply for access, use the platform or connect third-party services such as Vercel."
  >
    <section>
      <h2>1. Controller</h2>
      <p><strong>Diversa Nordic AB</strong>, organization number 556855-4884, Sweden, operates DIV3RSA and is the controller for personal data processed for account administration, platform operations, security, support, product administration and direct customer relationships unless a separate agreement establishes another role.</p>
      <p>Privacy questions and data-subject requests can be sent to <a href="mailto:info@div3rsa.com">info@div3rsa.com</a>.</p>
    </section>

    <section>
      <h2>2. Data we process</h2>
      <table className={styles.table}>
        <thead><tr><th>Category</th><th>Examples</th></tr></thead>
        <tbody>
          <tr><td>Account and identity data</td><td>Name, email address, account identifiers, organization/workspace membership, role, authentication and security state.</td></tr>
          <tr><td>Access-request data</td><td>Information submitted when requesting access, organization details, intended use and review status.</td></tr>
          <tr><td>Service content</td><td>Prompts, messages, files, project context, instructions, generated output and user feedback that you submit through DIV3RSA.</td></tr>
          <tr><td>Integration data</td><td>Provider account/team identifiers, project or repository identifiers, resource names, installation/configuration identifiers, authorization scopes and connection state.</td></tr>
          <tr><td>Deployment and operational data</td><td>Deployment IDs, project IDs, status, environment/target, branch or commit metadata, webhook event identifiers, timestamps, error metadata and logs retrieved when requested.</td></tr>
          <tr><td>Usage and audit data</td><td>Feature usage, actions, execution approvals, timestamps, security/audit events, rate-limit information and system diagnostics.</td></tr>
          <tr><td>Device and network data</td><td>IP address, browser/user-agent information, request metadata and security-related technical information.</td></tr>
          <tr><td>Support communications</td><td>Messages, contact details, troubleshooting information and correspondence sent to support.</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>3. Why we process data and legal bases</h2>
      <p>Where the EU/EEA General Data Protection Regulation (GDPR) applies, we rely on one or more of the following legal bases:</p>
      <ul>
        <li><strong>Performance of a contract:</strong> to provide accounts, workspaces, integrations, requested platform functions, support and other contracted services.</li>
        <li><strong>Legitimate interests:</strong> to secure the service, prevent abuse, maintain auditability, troubleshoot faults, improve reliability, administer business relationships and understand how the product is used. We balance these interests against your rights and expectations.</li>
        <li><strong>Legal obligations:</strong> where processing is required for accounting, legal claims, regulatory requests or other applicable obligations.</li>
        <li><strong>Consent:</strong> where we specifically request consent and consent is the appropriate legal basis. Consent can be withdrawn without affecting prior lawful processing.</li>
      </ul>
    </section>

    <section>
      <h2>4. Vercel integration data</h2>
      <p>When you install the DIV3RSA Vercel integration, Vercel provides an authorization code and installation context that can include the selected Vercel user, team, projects, integration configuration and granted permissions. DIV3RSA exchanges the authorization code server-side and stores the resulting integration credential in protected server-side secret storage.</p>
      <p>DIV3RSA uses this information to discover the Vercel resources you deliberately authorized, display those resources inside your workspace and perform Vercel operations that an authorized user requests through the service.</p>
      <p>Vercel may also send signed webhook events about authorized deployments, projects and integration configuration changes. DIV3RSA verifies the signature before processing. We record the event identifier and limited operational metadata necessary to update deployment/project state and maintain an audit trail. We do not use Integration Webhooks as a general-purpose copy of all Vercel logs.</p>
      <div className={styles.callout}>Removing a project from the Vercel installation or disconnecting Vercel is intended to remove that project from the active DIV3RSA authorization boundary. You may also revoke the installation directly in Vercel.</div>
    </section>

    <section>
      <h2>5. AI processing</h2>
      <p>Information submitted to DIV3RSA may be processed by the model and agent infrastructure configured for your workspace in order to generate responses, analyze code or operational data, execute approved workflows and maintain relevant product context. The platform is designed to separate credentials from model-visible content: provider access tokens and client secrets should not be exposed to the model or normal client-side interfaces.</p>
      <p>We do not make decisions producing legal or similarly significant effects about you solely through automated processing unless such processing is separately disclosed and lawfully implemented.</p>
    </section>

    <section>
      <h2>6. Service providers and recipients</h2>
      <p>We may use service providers to operate DIV3RSA, including infrastructure, database/authentication, hosting, security, email and connected integration providers. Depending on the features you use, these can include services such as Supabase, Vercel, GitHub and email infrastructure providers. A connected provider also processes data under its own terms and privacy policy.</p>
      <p>We may disclose data when necessary to professional advisers, auditors, insurers, authorities or courts, or in connection with a corporate transaction, where permitted or required by law.</p>
      <p><strong>We do not sell personal data to advertisers.</strong></p>
    </section>

    <section>
      <h2>7. International transfers</h2>
      <p>Some service providers may process information outside Sweden or the EU/EEA. Where GDPR requires a transfer mechanism, we use an applicable adequacy decision, the European Commission's Standard Contractual Clauses, or another lawful safeguard, together with supplementary measures where appropriate.</p>
    </section>

    <section>
      <h2>8. Retention</h2>
      <p>We retain personal data only for as long as necessary for the purpose for which it was collected, including providing the service, maintaining security and auditability, resolving disputes and meeting legal obligations.</p>
      <p>Retention periods vary by data type. Active account and workspace information is generally kept while the account or business relationship remains active. Security and audit records may be retained after an account closes where necessary to protect the service or establish legal claims. Connected-resource records are removed or deactivated when a connection is disconnected, subject to backup cycles, security records and legal requirements.</p>
      <p>Where an organization controls data processed by DIV3RSA under a separate data-processing agreement, contractual retention and deletion terms may apply instead.</p>
    </section>

    <section>
      <h2>9. Security</h2>
      <p>We use technical and organizational safeguards appropriate to the nature of the service, including authentication and role controls, server-side secret handling, least-privilege integration scopes, signed-webhook validation, access checks, audit records and environment separation. No system can guarantee absolute security, and users must also protect their credentials and connected accounts.</p>
    </section>

    <section>
      <h2>10. Cookies and authentication</h2>
      <p>DIV3RSA uses cookies or equivalent browser storage where necessary for authentication, session continuity, security and essential application functionality. We do not require advertising cookies to provide the core DIV3RSA service. If optional analytics or other non-essential tracking is introduced where consent is required, it will be handled separately.</p>
    </section>

    <section>
      <h2>11. Your rights</h2>
      <p>Subject to applicable law, you may have the right to request access to your personal data, correction, deletion, restriction, portability or objection to certain processing. Where processing is based on consent, you may withdraw consent. You may also have the right to complain to the competent supervisory authority.</p>
      <p>In Sweden, the supervisory authority is the <strong>Swedish Authority for Privacy Protection (Integritetsskyddsmyndigheten, IMY)</strong>. You may contact us first at <a href="mailto:info@div3rsa.com">info@div3rsa.com</a> so we can address the request.</p>
      <p>We may need to verify your identity before fulfilling a request and may retain limited information where required by law or necessary to protect legal claims and security.</p>
    </section>

    <section>
      <h2>12. Organization-controlled data</h2>
      <p>If you use DIV3RSA through an employer, customer or other organization, that organization may control parts of the workspace and may be the controller for personal data submitted in its business context. In those cases, requests about organization-controlled content may need to be directed to that organization. Diversa Nordic may act as a processor for such data under the applicable agreement.</p>
    </section>

    <section>
      <h2>13. Children</h2>
      <p>DIV3RSA is a professional service and is not directed to children. We do not knowingly offer the service to children in circumstances that would require parental consent under applicable data-protection law.</p>
    </section>

    <section>
      <h2>14. Changes to this policy</h2>
      <p>We may update this Privacy Policy when the service, processing activities or legal requirements change. The updated version will be published on this page with a revised “Last updated” date. Material changes will be communicated by additional reasonable means where required.</p>
    </section>

    <section>
      <h2>15. Contact</h2>
      <p>Privacy requests and questions: <a href="mailto:info@div3rsa.com">info@div3rsa.com</a>.</p>
      <p>Operator: Diversa Nordic AB, organization number 556855-4884, Sweden.</p>
    </section>
  </PublicInfoLayout>;
}
