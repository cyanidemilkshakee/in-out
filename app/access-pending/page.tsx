import styles from "./page.module.css";

export default function AccessPendingPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="pending-title">
        <div className={styles.icon} aria-hidden="true">…</div>
        <p className={styles.eyebrow}>IN / OUT · ZOHO SIGN-IN</p>
        <h1 id="pending-title">Access is awaiting approval</h1>
        <p className={styles.message}>
          No invitation is needed. Your Zoho account is signed in, but it does not have an In / Out role yet. A Master Admin must review the account and assign an operator or zone-admin role before you can use the application.
        </p>
        <div className={styles.requirement}>
          <span>Next step</span>
          <strong>Wait for a Master Admin to approve your access</strong>
        </div>
        <p className={styles.nextStep}>After approval, sign out and sign in again with the same Zoho account so the new access takes effect.</p>
        <form className={styles.actions} action="/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </section>
    </main>
  );
}
