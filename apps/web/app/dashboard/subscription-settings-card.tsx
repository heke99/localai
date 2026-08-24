"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./workspace-shell-v3.module.css";

export function SubscriptionSettingsCard({ isSuperadmin }: { isSuperadmin: boolean }) {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(() => {
    const syncTarget = () => {
      const nextTarget = document.querySelector(`.${styles.settingsGrid}`);
      setTarget((current) => current === nextTarget ? current : nextTarget);
    };

    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!target) return null;

  return createPortal(
    <article>
      <span>Subscription</span>
      <strong>{isSuperadmin ? "Systemkonto" : "Abonnemang"}</strong>
      <small>
        {isSuperadmin
          ? "Superadmin har systemåtkomst och debiteras inte som en vanlig kundorganisation."
          : "Plan, betalning, paus, förnyelse och fakturor för arbetsytan."}
      </small>
      <Link href={isSuperadmin ? "/settings/subscription" : "/billing"}>
        {isSuperadmin ? "Visa subscription-status" : "Hantera abonnemang"}
      </Link>
    </article>,
    target
  );
}
