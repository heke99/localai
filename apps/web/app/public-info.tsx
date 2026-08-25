import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./public-info.module.css";

export function PublicInfoLayout({ eyebrow, title, intro, children, lastUpdated = "25 August 2026" }: { eyebrow: string; title: string; intro: string; children: ReactNode; lastUpdated?: string }) {
  return <main className={styles.page}>
    <nav className={styles.nav}><Link className={styles.brand} href="/">DIV3RSA</Link><div className={styles.links}><Link href="/docs/vercel-integration">Documentation</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/cookies">Cookies</Link><Link href="/legal/eula">EULA</Link><Link href="/support">Support</Link></div><Link className={styles.signIn} href="/sign-in">Sign in</Link></nav>
    <header className={styles.hero}><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1><p className={styles.intro}>{intro}</p><p className={styles.updated}>Last updated: {lastUpdated}</p></header>
    <article className={styles.article}>{children}</article>
    <footer className={styles.footer}><div><strong>DIV3RSA</strong><span>Operated by Attmos AB · Org. no. 556855-4884 · Sweden</span></div><div className={styles.footerLinks}><Link href="/docs/vercel-integration">Documentation</Link><Link href="/legal/privacy">Privacy Policy</Link><Link href="/legal/cookies">Cookie Policy</Link><Link href="/legal/eula">EULA</Link><Link href="/support">Support</Link><a href="mailto:info@div3rsa.com">info@div3rsa.com</a></div></footer>
  </main>;
}
