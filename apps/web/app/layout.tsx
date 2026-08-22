import type { Metadata } from "next";
import "./globals.css";
import controlStyles from "./superadmin/control-center.module.css";

export const metadata: Metadata = {
  title: "DIV3RSA Intelligence",
  description: "Private model-agnostic agent platform for engineering, research and authorized security work."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sv"><body className={controlStyles.root}>{children}</body></html>;
}
