import type { NextRequest } from "next/server";
import { updateSession } from "./lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/account/:path*",
    "/account-paused/:path*",
    "/dashboard/:path*",
    "/superadmin/:path*",
    "/verify-email/:path*",
    "/auth/:path*",
    "/api/agent/:path*",
    "/api/conversations/:path*",
    "/api/integrations/:path*",
    "/api/memory/:path*",
    "/api/projects/:path*",
    "/api/runs/:path*",
    "/api/superadmin/:path*"
  ]
};
