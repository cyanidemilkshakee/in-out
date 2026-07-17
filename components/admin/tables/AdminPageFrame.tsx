import type { ReactNode } from 'react';

export function AdminPageFrame({
  title,
  description,
  metric,
  headerRight,
  children
}: {
  title: string;
  description: string;
  metric?: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="admin-page-frame">
      <section className="admin-model-hero">
        <div className="admin-hero-copy">
          <div>
            <h1 style={{ lineHeight: 1.25 }}>{title}</h1>
            <p style={{ lineHeight: 1.5 }}>{description}</p>
            {metric ? <div className="admin-hero-metric">{metric}</div> : null}
          </div>
        </div>
        {headerRight && (
          <div className="admin-hero-visual">
            {headerRight}
          </div>
        )}
      </section>
      {children}
    </div>
  );
}
