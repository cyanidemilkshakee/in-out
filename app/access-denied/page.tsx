import styles from "./page.module.css";

export default async function AccessDeniedPage(props: {
  searchParams: Promise<{ area?: string }>;
}) {
  const { area } = await props.searchParams;
  const terminal = area === "terminal";
  const title = terminal ? "Terminal access required" : "Administrator access required";

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="access-denied-title">
        <div className={styles.icon} aria-hidden="true">!</div>
        <p className={styles.eyebrow}>IN / OUT · ACCESS CONTROL</p>
        <h1 id="access-denied-title">{title}</h1>
        {terminal ? (
          <>
            <p className={styles.message}>
              You are signed in, but this account does not have permission to open the Security Terminal.
            </p>
            <div className={styles.requirement}>
              <span>Required access</span>
              <strong>Operator or Zone Admin</strong>
            </div>
            <p className={styles.nextStep}>
              Ask your Zone Admin or Master Admin to assign the appropriate role. Then sign out and sign in again to refresh your access.
            </p>
          </>
        ) : (
          <>
            <p className={styles.message}>
              You are signed in, but this account does not have permission to open this administration page.
            </p>
            <div className={styles.requirement}>
              <span>Required access</span>
              <strong>Zone Admin or Master Admin</strong>
            </div>
            <p className={styles.nextStep}>
              Ask a Master Admin to review your account role. After a role change, sign out and sign in again to refresh your access.
            </p>
          </>
        )}
        <form className={styles.actions} action="/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </section>
    </main>
  );
}
