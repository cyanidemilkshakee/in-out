"use client";

import { useSyncExternalStore } from "react";

type AdminTheme = "light" | "dark";

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function getSnapshot(): AdminTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.adminTheme === "dark" ? "dark" : "light";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer && typeof document !== "undefined") {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-admin-theme"],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

export function useAdminTheme() {
  return useSyncExternalStore(subscribe, getSnapshot, () => "light" as const);
}
