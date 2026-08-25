import type { Metadata } from "next";
import { PublicInfoLayout } from "../../public-info";
import styles from "../../public-info.module.css";

export const metadata: Metadata = {
  title: "Cookie Policy | DIV3RSA",
  description: "Cookie and browser-storage policy for DIV3RSA, operated by Attmos AB."
};

export default function CookiePolicyPage() {
  return <PublicInfoLayout eyebrow="Privacy" title="Cookie Policy" intro="This policy explains which cookies and similar browser storage DIV3RSA uses, why they are needed and how you can control optional storage." lastUpdated="25 August 2026">
    <section><h2>1. Operator</h2><p><strong>Attmos AB</strong>, organization number 556855-4884, Sweden, operates DIV3RSA. Questions about cookies or personal data can be sent to <a href="mailto:info@div3rsa.com">info@div3rsa.com</a>.</p></section>
    <section><h2>2. Necessary cookies and storage</h2><p>DIV3RSA may use cookies or equivalent browser storage that are necessary for authentication, session continuity, security, load protection and other functionality that you explicitly request. Necessary storage is not used for advertising.</p><p>When you sign in, the authentication service can place project-specific session cookies used to keep you securely signed in and rotate authentication tokens. Their lifetime follows the authentication session and its configured security rules.</p></section>
    <section><h2>3. Cookie preference storage</h2><table className={styles.table}><thead><tr><th>Name</th><th>Type</th><th>Purpose</th><th>Duration</th></tr></thead><tbody><tr><td><code>div3rsa-cookie-consent-v1</code></td><td>Local storage</td><td>Remembers whether you allowed or rejected optional cookies/storage.</td><td>Until you clear site data or we replace the consent-policy version.</td></tr></tbody></table></section>
    <section><h2>4. Optional analytics and marketing</h2><p>The public DIV3RSA site does not currently require optional analytics or advertising cookies. If optional analytics or marketing technology is introduced, it must remain disabled until you actively consent. This policy will then be updated with the relevant provider, purpose, storage name and duration before such technology is used.</p></section>
    <section><h2>5. Your choice</h2><p>On your first visit you can allow or reject optional cookies with equally available choices. Necessary cookies remain available because they are required for functions such as authentication and security.</p><p>You can reopen the consent panel at any time using the <strong>Cookieinställningar</strong> button and change your choice.</p></section>
    <section><h2>6. Browser controls</h2><p>You can also delete cookies and local storage through your browser. Blocking necessary authentication storage may prevent sign-in or other requested functions from working correctly.</p></section>
    <section><h2>7. Contact</h2><p>Attmos AB · Org. no. 556855-4884 · Sweden · <a href="mailto:info@div3rsa.com">info@div3rsa.com</a>.</p><p>For more information about personal-data processing, see the <a href="/legal/privacy">Privacy Policy</a>.</p></section>
  </PublicInfoLayout>;
}
