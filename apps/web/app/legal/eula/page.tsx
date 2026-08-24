import type { Metadata } from "next";
import { PublicInfoLayout } from "../../public-info";

export const metadata: Metadata = {
  title: "End User License Agreement | DIV3RSA",
  description: "End User License Agreement for DIV3RSA and the DIV3RSA Vercel integration."
};

export default function EulaPage() {
  return <PublicInfoLayout
    eyebrow="Legal"
    title="End User License Agreement"
    intro="This End User License Agreement governs access to and use of DIV3RSA, including the DIV3RSA Vercel integration and related software, interfaces and services."
  >
    <section>
      <h2>1. Agreement and operator</h2>
      <p>This End User License Agreement (the <strong>“EULA”</strong>) is between you, or the organization you represent, and <strong>Diversa Nordic AB</strong>, organization number 556855-4884, Sweden (<strong>“Diversa Nordic”, “DIV3RSA”, “we”, “us”</strong>).</p>
      <p>By installing the DIV3RSA Vercel integration, creating or using a DIV3RSA account, or otherwise accessing the service, you agree to this EULA. If you use DIV3RSA on behalf of an organization, you represent that you are authorized to bind that organization. If you do not agree, do not install or use the service.</p>
    </section>

    <section>
      <h2>2. The service</h2>
      <p>DIV3RSA is an AI-assisted workspace for engineering, research, automation and authorized security work. The service may connect to third-party systems selected by the user, including Vercel and GitHub, in order to read authorized resources, analyze operational information and perform actions expressly initiated or approved through DIV3RSA.</p>
      <p>Features may change as the service develops. Preview, beta or experimental functionality may be modified or discontinued without the same guarantees as generally available functionality.</p>
    </section>

    <section>
      <h2>3. License and permitted use</h2>
      <p>Subject to this EULA and any applicable commercial agreement, DIV3RSA grants you a limited, non-exclusive, non-transferable, non-sublicensable and revocable right to access and use the service for your internal lawful purposes during the applicable subscription or authorized-access period.</p>
      <p>You may use integrations only for accounts, teams, projects, repositories, systems and data that you are authorized to access. You remain responsible for the instructions you give the service and for verifying material actions before relying on their outcome.</p>
    </section>

    <section>
      <h2>4. Prohibited use</h2>
      <p>You must not use DIV3RSA to:</p>
      <ul>
        <li>access, test, alter, disrupt or obtain data from systems without authorization or another lawful basis;</li>
        <li>circumvent access controls, usage limits, security controls or third-party permissions;</li>
        <li>introduce malware, destructive code or intentionally harmful automated activity;</li>
        <li>use the service in violation of applicable law, sanctions, export controls or third-party rights;</li>
        <li>sell, lease, sublicense or provide unauthorized third parties with access to your DIV3RSA account or integration credentials;</li>
        <li>reverse engineer the service except where such restriction is prohibited by mandatory law; or</li>
        <li>misrepresent DIV3RSA output as independently verified when it has not been reviewed or validated.</li>
      </ul>
    </section>

    <section>
      <h2>5. Accounts and security</h2>
      <p>You are responsible for protecting your account, authentication factors and authorized integration connections. You must promptly notify us if you reasonably believe an account or connection has been compromised. You must not disclose Vercel client secrets, access tokens, API keys or similar credentials through prompts, support tickets or other channels unless a secure process specifically requires it.</p>
      <p>We may suspend or restrict access where reasonably necessary to protect the service, users, connected systems or third parties, to investigate suspected abuse, or to comply with law.</p>
    </section>

    <section>
      <h2>6. Third-party integrations</h2>
      <p>DIV3RSA can integrate with independent third-party services. Those services are governed by their own terms, privacy notices, availability and security controls. Installing an integration does not transfer ownership of the third-party account to DIV3RSA.</p>
      <p>For the Vercel integration, the Vercel account owner selects the account/team and projects made available and approves the requested Vercel permissions. DIV3RSA may use the resulting installation credential to perform the functions described in the integration documentation. You may change or revoke Vercel access through Vercel and may also disconnect the connection in DIV3RSA.</p>
    </section>

    <section>
      <h2>7. User content and connected data</h2>
      <p>You retain your rights in content, code, data and other materials you provide or make available through connected services. You grant DIV3RSA the limited rights necessary to host, process, transmit, analyze and display that material solely to provide, secure, maintain and improve the service as permitted by applicable law and your agreements with us.</p>
      <p>You are responsible for ensuring that you have a lawful basis and all necessary rights to submit personal data, code, logs or third-party material to the service.</p>
    </section>

    <section>
      <h2>8. AI-assisted output</h2>
      <p>DIV3RSA may generate recommendations, code, analysis or other output using automated systems. Output can be incomplete, inaccurate or unsuitable for a particular purpose. You must apply appropriate human review before using output for production changes, security decisions, legal, financial, safety-critical or similarly consequential purposes.</p>
      <p>Where the service can execute an action against a connected system, the applicable access controls and approval mechanisms remain part of the authorization boundary. You are responsible for the final business decision to approve, deploy or rely on an action.</p>
    </section>

    <section>
      <h2>9. Intellectual property</h2>
      <p>DIV3RSA, its software, user interface, documentation, trademarks and related technology are owned by Diversa Nordic or its licensors and are protected by applicable intellectual-property laws. Except for the limited license granted in this EULA, no rights in DIV3RSA are transferred to you.</p>
      <p>Feedback may be used by us without restriction or payment, provided we do not publicly identify you as its source without permission.</p>
    </section>

    <section>
      <h2>10. Privacy and confidentiality</h2>
      <p>Our processing of personal data is described in the <a href="/legal/privacy">DIV3RSA Privacy Policy</a>. If a separate data processing agreement applies to your organization, that agreement governs processing carried out on your organization's behalf where it conflicts with this EULA.</p>
      <p>Each party must use reasonable care to protect confidential information received from the other party and use it only for the purpose for which it was disclosed, subject to applicable law and any separate agreement.</p>
    </section>

    <section>
      <h2>11. Availability and changes</h2>
      <p>We aim to operate DIV3RSA reliably, but the service is not guaranteed to be uninterrupted or error-free unless a separate written service-level agreement expressly states otherwise. Maintenance, security incidents, provider outages, internet failures and changes to third-party APIs may temporarily affect availability.</p>
      <p>We may update the service and this EULA. Material changes will be communicated by reasonable means where required. Continued use after an effective update constitutes acceptance to the extent permitted by law.</p>
    </section>

    <section>
      <h2>12. Fees</h2>
      <p>Fees, usage limits, payment terms and renewal conditions, if applicable, are stated in the order, subscription, proposal or other commercial agreement associated with your account. Third-party providers may charge their own fees independently of DIV3RSA.</p>
    </section>

    <section>
      <h2>13. Term and termination</h2>
      <p>This EULA applies while you access or use DIV3RSA. You may stop using the service and disconnect third-party integrations at any time, subject to any separate contractual commitments. We may terminate or suspend access for material breach, unlawful use, security risk, non-payment where applicable, or when required by law.</p>
      <p>On termination, your license to use DIV3RSA ends. Provisions that by their nature should survive termination, including intellectual property, confidentiality, accrued payment obligations, disclaimers, limitations of liability and dispute provisions, remain effective.</p>
    </section>

    <section>
      <h2>14. Warranties and disclaimers</h2>
      <p>To the maximum extent permitted by law, DIV3RSA is provided on an “as is” and “as available” basis. We disclaim implied warranties of merchantability, fitness for a particular purpose and non-infringement to the extent such warranties can legally be excluded. Nothing in this EULA excludes warranties or statutory rights that cannot be waived under applicable law.</p>
    </section>

    <section>
      <h2>15. Limitation of liability</h2>
      <p>To the maximum extent permitted by law, neither party is liable to the other for indirect, incidental, special, exemplary or consequential loss, or loss of profit, revenue, goodwill or anticipated savings, arising from this EULA, except where such limitation is prohibited by law.</p>
      <p>Unless a separate written agreement states a different cap, Diversa Nordic's aggregate liability arising from the service is limited to the amounts paid or payable by you for DIV3RSA during the twelve months preceding the event giving rise to the claim. This limitation does not apply where liability cannot lawfully be limited, including liability for fraud or intentional misconduct.</p>
    </section>

    <section>
      <h2>16. Governing law and disputes</h2>
      <p>This EULA is governed by Swedish law, without regard to conflict-of-law rules. Disputes that cannot be resolved amicably are subject to the courts of Sweden. Where mandatory consumer-protection rules grant you the right to bring a claim elsewhere or apply other mandatory protections, those rights are not limited by this section.</p>
    </section>

    <section>
      <h2>17. Contact</h2>
      <p>Questions about this EULA or the DIV3RSA service can be sent to <a href="mailto:info@div3rsa.com">info@div3rsa.com</a> or through the <a href="/support">Support page</a>.</p>
    </section>
  </PublicInfoLayout>;
}
