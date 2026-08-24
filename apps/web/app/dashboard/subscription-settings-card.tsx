"use client";

import { useEffect } from "react";
import styles from "./workspace-shell-v3.module.css";

export function SubscriptionSettingsCard({ isSuperadmin }: { isSuperadmin: boolean }) {
  useEffect(() => {
    const selector = '[data-subscription-settings-card="true"]';

    const syncCard = () => {
      const grid = document.querySelector<HTMLElement>(`.${styles.settingsGrid}`);
      const existing = document.querySelector<HTMLElement>(selector);

      if (!grid) {
        existing?.remove();
        return;
      }
      if (existing?.parentElement === grid) return;
      existing?.remove();

      const article = document.createElement("article");
      article.dataset.subscriptionSettingsCard = "true";

      const label = document.createElement("span");
      label.textContent = "Subscription";

      const title = document.createElement("strong");
      title.textContent = isSuperadmin ? "Systemkonto" : "Abonnemang";

      const description = document.createElement("small");
      description.textContent = isSuperadmin
        ? "Superadmin har systemåtkomst och debiteras inte som en vanlig kundorganisation."
        : "Plan, betalning, paus, förnyelse och fakturor för arbetsytan.";

      const link = document.createElement("a");
      link.href = isSuperadmin ? "/settings/subscription" : "/billing";
      link.textContent = isSuperadmin ? "Visa subscription-status" : "Hantera abonnemang";

      article.append(label, title, description, link);
      grid.append(article);
    };

    syncCard();
    const observer = new MutationObserver(syncCard);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      document.querySelector<HTMLElement>(selector)?.remove();
    };
  }, [isSuperadmin]);

  return null;
}
