import type { Metadata } from "next";
import "./globals.css";
import "./dashboard-layout.css";
import "./professional-ui-overrides.css";
import "./legal-compliance.css";
import controlStyles from "./superadmin/control-center.module.css";
import { CookieConsent } from "./cookie-consent";

export const metadata: Metadata = {
  title: "DIV3RSA Intelligence",
  description: "AI-assisted workspace for engineering, research and authorized security work.",
  applicationName: "DIV3RSA",
  authors: [{ name: "Attmos AB" }],
  creator: "Attmos AB",
  publisher: "Attmos AB"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sv"><body className={controlStyles.root}>{children}<CookieConsent /></body></html>;
}
