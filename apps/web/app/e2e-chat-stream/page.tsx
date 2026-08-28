import { notFound } from "next/navigation";
import { ChatStreamHarness } from "./harness";

export const dynamic = "force-dynamic";

export default function ChatStreamHarnessPage() {
  if (process.env.DIV3RSA_E2E_UI_HARNESS !== "1") notFound();
  return <ChatStreamHarness />;
}
