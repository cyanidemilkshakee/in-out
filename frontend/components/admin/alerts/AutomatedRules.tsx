"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { AlertRule } from "../../../../lib/types";

function ruleEligibility(rule: AlertRule) {
  if (rule.conditionKey === "cross_building_scan") return "Eligible: All employees and visitors";
  if (rule.conditionKey === "visitor_overstay") return "Eligible: All visitors";
  const names = { employee: "Employees", visitor: "Visitors", hardware: "Hardware" };
  const assignment = rule.conditionKey === "no_break" || rule.conditionKey === "irregularity" ? " · Assigned per employee" : "";
  return `Eligible: ${(rule.eligibleSubjectTypes ?? ["employee"]).map((kind) => names[kind]).join(", ")}${assignment}`;
}

export function AutomatedRules({ rules }: { rules: AlertRule[] }) {
  const ruleListRef = useRef<HTMLDivElement>(null);
  const [threeRuleHeight, setThreeRuleHeight] = useState<number>();

  useLayoutEffect(() => {
    const list = ruleListRef.current;
    if (!list) return;

    const updateVisibleHeight = () => {
      const cards = Array.from(list.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("alert-rule-card"),
      );

      if (cards.length <= 3) {
        setThreeRuleHeight(undefined);
        return;
      }

      const styles = window.getComputedStyle(list);
      const gap = Number.parseFloat(styles.rowGap) || 0;
      const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0)
        + (Number.parseFloat(styles.paddingBottom) || 0);
      const visibleHeight = cards.slice(0, 3).reduce((height, card) => height + card.getBoundingClientRect().height, 0)
        + gap * 2
        + verticalPadding;

      setThreeRuleHeight((current) => current === visibleHeight ? current : visibleHeight);
    };

    updateVisibleHeight();
    const observer = new ResizeObserver(updateVisibleHeight);
    observer.observe(list);
    Array.from(list.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [rules]);

  return (
    <section className="permission-rules alert-rules-section admin-surface" aria-labelledby="alert-rules-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-rules-title">Automated rules</h2>
        </div>
        <span>{rules.filter((rule) => rule.enabled).length} enabled</span>
      </div>
      <div
        className="alert-rule-list scrollable-content"
        ref={ruleListRef}
        style={threeRuleHeight === undefined ? undefined : { maxHeight: `${threeRuleHeight}px` }}
      >
        {rules.map((rule) => (
          <article className="alert-rule-card admin-surface" key={rule.id}>
            <header>
              <span>
                <strong>{rule.name}</strong>
                <small>{rule.description}</small>
              </span>
              <span className="alert-rule-status admin-surface" data-enabled={rule.enabled}>{rule.enabled ? "Enabled" : "Disabled"}</span>
            </header>
            <footer>
              <span className="alert-rule-trigger">{rule.recentTriggers} Triggers / last 7 days</span>
              <small className="alert-rule-eligibility">{ruleEligibility(rule)}</small>
            </footer>
          </article>
        ))}
        {!rules.length && <p className="alert-section-empty">No automated rules are available.</p>}
      </div>
    </section>
  );
}
