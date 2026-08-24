# Vercel least-privilege contract

The Vercel integration may expose only capabilities backed by implemented gateway tools.

| DIV3RSA capability | Gateway tool | Vercel access |
| --- | --- | --- |
| `vercel.project.read` | resource discovery | Project Read |
| `vercel.deployments.read` | `vercel_read_deployments` | Deployment Read |
| `vercel.logs.read` | `vercel_read_logs` | Deployment/log Read |
| `vercel.deployments.create` | `vercel_create_deployment` | Deployment Write |
| `vercel.deployments.rollback` | `vercel_rollback_deployment` | Deployment Write |

Environment and domain permissions are intentionally not requested by default because no corresponding gateway tools are currently implemented.
