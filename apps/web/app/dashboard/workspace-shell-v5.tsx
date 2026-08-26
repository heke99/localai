"use client";

import { useEffect, useRef } from "react";
import { WorkspaceShellV4 } from "./workspace-shell-v4";
import styles from "./workspace-shell-v3.module.css";

type WorkspaceShellV5Props = Parameters<typeof WorkspaceShellV4>[0];

const PREWARM_DEBOUNCE_MS = 250;
const PREWARM_COOLDOWN_MS = 30_000;
const DELETE_RETRY_TIMEOUT_MS = 3_000;

function isDeleteButton(target: EventTarget | null): target is HTMLButtonElement {
  if (!(target instanceof Element)) return false;
  const button = target.closest("button");
  if (!(button instanceof HTMLButtonElement)) return false;
  if (button.title === "Radera chatt") return true;
  if (button.getAttribute("aria-label")?.startsWith("Radera projektet ")) return true;
  return Boolean(button.closest(`.${styles.projectActions}`) && button.textContent?.trim().startsWith("Radera"));
}

export function WorkspaceShellV5(props: WorkspaceShellV5Props) {
  const prewarmTimer = useRef<number | null>(null);
  const lastPrewarmAt = useRef(0);
  const deleteRetrying = useRef(false);

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

    function retryDeleteAfterAutomaticCancel(event: MouseEvent) {
      if (!isDeleteButton(event.target) || event.target.disabled || deleteRetrying.current) return;
      const deleteButton = event.target;

      window.requestAnimationFrame(() => {
        const errorText = document.querySelector(`.${styles.error}`)?.textContent ?? "";
        const blockedByRun = errorText.includes("Stoppa") && errorText.includes("rader");
        if (!blockedByRun) return;

        const stopButton = Array.from(document.querySelectorAll(`.${styles.runBar} button`))
          .find((button): button is HTMLButtonElement => button instanceof HTMLButtonElement && button.textContent?.trim() === "Stoppa");
        if (!stopButton) return;

        deleteRetrying.current = true;
        stopButton.click();
        const startedAt = Date.now();

        const retryWhenCancelled = () => {
          const stillRunning = Array.from(document.querySelectorAll(`.${styles.runBar} button`))
            .some((button) => button instanceof HTMLButtonElement && button.textContent?.trim() === "Stoppa");

          if (!stillRunning) {
            deleteRetrying.current = false;
            if (deleteButton.isConnected && !deleteButton.disabled) deleteButton.click();
            return;
          }

          if (Date.now() - startedAt >= DELETE_RETRY_TIMEOUT_MS) {
            deleteRetrying.current = false;
            return;
          }

          window.setTimeout(retryWhenCancelled, 100);
        };

        window.setTimeout(retryWhenCancelled, 100);
      });
    }

    document.addEventListener("input", schedulePrewarm, true);
    document.addEventListener("click", retryDeleteAfterAutomaticCancel, true);
    return () => {
      document.removeEventListener("input", schedulePrewarm, true);
      document.removeEventListener("click", retryDeleteAfterAutomaticCancel, true);
      if (prewarmTimer.current !== null) window.clearTimeout(prewarmTimer.current);
    };
  }, [props.workspaceId]);

  const statusStyles = `
    .${styles.messageStream} {
      align-items: start;
    }
    .${styles.userMessage} {
      justify-self: end;
      width: min(76%, 680px);
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 6px !important;
    }
    .${styles.userMessage} .${styles.messageMeta} {
      text-align: right;
      padding: 0 8px 0 0;
    }
    .${styles.userMessage} .${styles.messageBody} {
      justify-self: end;
      width: fit-content;
      max-width: 100%;
      padding: 10px 13px;
      border: 1px solid #30333a;
      border-radius: 16px 16px 4px 16px;
      background: #1b1e23;
    }
    .${styles.assistantMessage} {
      justify-self: start;
      width: min(88%, 760px);
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 6px !important;
    }
    .${styles.assistantMessage} .${styles.messageMeta} {
      padding: 0 0 0 2px;
    }
    .${styles.assistantMessage} .${styles.messageBody} {
      max-width: 100%;
    }
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
    @media (max-width: 700px) {
      .${styles.userMessage} { width: 88%; }
      .${styles.assistantMessage} { width: 96%; }
    }
  `;

  return <>
    <WorkspaceShellV4 {...props} />
    <style>{statusStyles}</style>
  </>;
}