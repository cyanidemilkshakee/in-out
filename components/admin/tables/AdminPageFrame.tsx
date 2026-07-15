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
        <div className="admin-hero-copy" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div>
            <h1 style={{ lineHeight: 1.25 }}>{title}</h1>
            <p style={{ lineHeight: 1.5 }}>{description}</p>
            {metric ? <div className="admin-hero-metric">{metric}</div> : null}
          </div>
        </div>
        {headerRight && (
          <div style={{
            padding: '12px 0 2px 16px',
            display: 'flex',
            alignItems: 'stretch',
            minWidth: 0,
            width: '100%',
            alignSelf: 'stretch',
          }}>
            {headerRight}
          </div>
        )}
      </section>
      {children}
    </div>
  );
}
