import Link from "next/link";

export default function SuperadminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>
    {children}
    <Link
      href="/superadmin/manage"
      className="button primary"
      style={{ position: "fixed", right: 22, bottom: 22, zIndex: 60, boxShadow: "0 12px 32px rgba(0,0,0,.28)" }}
    >
      Management actions
    </Link>
  </>;
}
