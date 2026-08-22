import "server-only";

export function getAppUrl() {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionHost) return `https://${productionHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost) return `https://${deploymentHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

  return "http://localhost:3000";
}
