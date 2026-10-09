import type { ReactNode } from 'react';

export function AdminPageFrame({
  title,
  metric,
  headerRight,
  preTitle,
  children
}: {
  title: string;
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
