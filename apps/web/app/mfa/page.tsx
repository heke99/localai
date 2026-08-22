import { redirect } from "next/navigation";

export default function LegacyMfaRedirect() {
  redirect("/verify-email");
}
