import type { ReactNode } from 'react';

export function AdminPageFrame({
  title,
  description,
  metric,
  headerRight,
  preTitle,
  children
}: {
  title: string;
  description: string;
  metric?: ReactNode;
  headerRight?: ReactNode;
  preTitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="admin-page-frame">
      <section className="admin-model-hero">
        <div className="admin-hero-copy">
          <div>
            {preTitle && <div className="admin-hero-pretitle">{preTitle}</div>}
            <h1 className="admin-hero-title">{title}</h1>
            <p className="admin-hero-description">{description}</p>
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
