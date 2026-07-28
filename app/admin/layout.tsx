"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";
import { AppChrome } from "../../components/AppChrome";
import { AdminNavRail } from "../../components/admin/AdminNavRail";
import "./admin.css";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [scrolled, setScrolled] = useState(false);
  const [scrollTint, setScrollTint] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const scrolledRef = useRef(false);
  const scrollTintRef = useRef(0);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      const nextScrolled = scrollTop > 100;
      const nextTint = Math.min(1, Math.max(0, scrollTop / 180));
      if (nextScrolled !== scrolledRef.current) {
        scrolledRef.current = nextScrolled;
        setScrolled(nextScrolled);
      }
      if (
        Math.abs(nextTint - scrollTintRef.current) > 0.04 ||
        nextTint === 0 ||
        nextTint === 1
      ) {
        scrollTintRef.current = nextTint;
        setScrollTint(nextTint);
      }
    });
  }, []);

  const handleKeyboardScroll = useCallback((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    const container = scrollRef.current;
    if (!container) return;
    const pageStep = Math.max(240, Math.round(container.clientHeight * 0.8));
    let nextTop: number | null = null;
    if (event.key === "ArrowDown") nextTop = container.scrollTop + 80;
    if (event.key === "ArrowUp") nextTop = container.scrollTop - 80;
    if (event.key === "PageDown") nextTop = container.scrollTop + pageStep;
    if (event.key === "PageUp") nextTop = container.scrollTop - pageStep;
    if (event.key === "Home") nextTop = 0;
    if (event.key === "End") nextTop = container.scrollHeight;
    if (nextTop === null) return;

    event.preventDefault();
    container.scrollTo({ top: nextTop, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("inout-admin-theme");
    const initialTheme = storedTheme === "dark" ? "dark" : "light";
    setTheme(initialTheme);
    document.documentElement.dataset.adminTheme = initialTheme;
    window.localStorage.setItem("inout-admin-theme", initialTheme);

    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    document.addEventListener("keydown", handleKeyboardScroll);
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      document.removeEventListener("keydown", handleKeyboardScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [handleKeyboardScroll, handleScroll]);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.adminTheme = nextTheme;
    window.localStorage.setItem("inout-admin-theme", nextTheme);
  }

  return (
    <AppChrome role="admin">
      <main className="admin-console admin-shell-layout">
        <AdminNavRail scrollTint={scrollTint} />
        <div
          id="admin-scroll-container"
          ref={scrollRef}
          className={`admin-scroll-surface ${scrolled ? "scrolled-main-content" : "top-main-content"}`}
          tabIndex={0}
          aria-label="Admin content"
        >
          {children}
        </div>
        <button
          type="button"
          className="admin-theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        >
          {theme === "light" ? (
            <Moon size={20} strokeWidth={1.5} />
          ) : (
            <Sun size={20} strokeWidth={1.5} />
          )}
        </button>
      </main>
    </AppChrome>
  );
}
