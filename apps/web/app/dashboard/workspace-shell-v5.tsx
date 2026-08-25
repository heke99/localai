"use client";

import { WorkspaceShellV4 } from "./workspace-shell-v4";
import styles from "./workspace-shell-v3.module.css";

type WorkspaceShellV5Props = Parameters<typeof WorkspaceShellV4>[0];

export function WorkspaceShellV5(props: WorkspaceShellV5Props) {
  const statusStyles = `
    .${styles.runBar} {
      position: fixed !important;
      right: 22px !important;
      bottom: 112px !important;
      left: auto !important;
      margin: 0 !important;
      z-index: 40;
      max-width: min(360px, calc(100vw - 32px)) !important;
      padding: 7px 10px !important;
      box-shadow: 0 10px 28px rgba(0, 0, 0, .3) !important;
    }
    .${styles.runBar} > strong,
    .${styles.runBar} > span:not(.${styles.runDot}):not(.${styles.runError}) {
      display: none !important;
    }
    .${styles.runBar}:not(:has(.${styles.runDotIdle}))::before {
      content: "Arbetar…";
      color: #d8dadd;
      font-weight: 700;
    }
    .${styles.runBar}:has(.${styles.runDotIdle}):not(:has(.${styles.runError})) {
      display: none !important;
    }
  `;

  return <>
    <WorkspaceShellV4 {...props} />
    <style>{statusStyles}</style>
  </>;
}
