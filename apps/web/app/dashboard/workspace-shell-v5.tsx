"use client";

import { useEffect, useRef } from "react";
import { WorkspaceShellV4 } from "./workspace-shell-v4";
import styles from "./workspace-shell-v3.module.css";

type WorkspaceShellV5Props = Parameters<typeof WorkspaceShellV4>[0];

const PREWARM_DEBOUNCE_MS = 250;
const PREWARM_COOLDOWN_MS = 30_000;

export function WorkspaceShellV5(props: WorkspaceShellV5Props) {
  const prewarmTimer = useRef<number | null>(null);
  const lastPrewarmAt = useRef(0);

  useEffect(() => {
    function schedulePrewarm(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.closest(`.${styles.composer}`) || !target.value.trim()) return;
      if (Date.now() - lastPrewarmAt.current < PREWARM_COOLDOWN_MS) return;
      if (prewarmTimer.current !== null) window.clearTimeout(prewarmTimer.current);

      prewarmTimer.current = window.setTimeout(() => {
        prewarmTimer.current = null;
        lastPrewarmAt.current = Date.now();
        void fetch("/api/runtime/prewarm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: props.workspaceId }),
          keepalive: true
        }).catch(() => undefined);
      }, PREWARM_DEBOUNCE_MS);
    }

    document.addEventListener("input", schedulePrewarm, true);
    return () => {
      document.removeEventListener("input", schedulePrewarm, true);
      if (prewarmTimer.current !== null) window.clearTimeout(prewarmTimer.current);
    };
  }, [props.workspaceId]);

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
