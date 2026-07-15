"use client";

import type { HardwareAsset } from "../../../lib/types";

export function HardwarePicker({
  assets,
  selectedHardware,
  onToggle
}: {
  assets: HardwareAsset[];
  selectedHardware: string[];
  onToggle: (assetId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {assets.map((asset) => (
        <label key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', background: 'var(--surface-soft)', border: '1px solid var(--border)', borderRadius: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={selectedHardware.includes(asset.id)}
            onChange={() => onToggle(asset.id)}
            style={{ width: '20px', height: '20px', accentColor: 'var(--blue)' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <strong style={{ color: 'var(--text)', fontSize: '15px' }}>{asset.name}</strong>
            <small style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'monospace' }}>{asset.barcode} / {asset.owner}</small>
          </div>
          <em style={{ fontStyle: 'normal', fontSize: '12px', padding: '4px 8px', background: 'rgba(0,0,0,0.05)', borderRadius: '999px', color: 'var(--text)' }}>{asset.status}</em>
        </label>
      ))}
    </div>
  );
}
