import type { Checkpoint } from '../../../lib/types';

export function CheckpointTable({ checkpoints }: { checkpoints: Checkpoint[] }) {
  return (
    <section className="plain-panel">
      <div className="panel-titlebar">
        <div>
          <h1>Checkpoints</h1>
          <p>Configured checkpoint modes.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mode</th>
              <th>Zone</th>
            </tr>
          </thead>
          <tbody>
            {checkpoints.map((checkpoint) => {
              return (
                <tr key={checkpoint.id}>
                  <td>{checkpoint.name}</td>
                  <td>{checkpoint.mode}</td>
                  <td>{checkpoint.zone}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
