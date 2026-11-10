"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Cpu, LoaderCircle, MapPin, RotateCw, Search, UsersRound, X } from "lucide-react";
import type { OrganizationZone, RegistrySubjectPage } from "../../../lib/types";
import { DataServiceError, HttpDataService, readResponse } from "../../../services/httpDataService";
import styles from "./MasterZoneAssignments.module.css";

const PAGE_SIZE = 50;
const dataService = new HttpDataService();

type SubjectKind = "employee" | "hardware";
type SubjectRow = {
  id: string;
  name: string;
  barcode: string;
  allowedZones: string[];
  category?: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function orderedZoneIds(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function MasterZoneAssignments({ fixedKind }: { fixedKind?: SubjectKind }) {
  const [kind, setKind] = useState<SubjectKind>(fixedKind ?? "employee");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageData, setPageData] = useState<RegistrySubjectPage | null>(null);
  const [zones, setZones] = useState<OrganizationZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [zoneError, setZoneError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<SubjectRow | null>(null);
  const [draftZones, setDraftZones] = useState<string[]>([]);
  const [dialogError, setDialogError] = useState("");

  const loadZones = useCallback(async (signal?: AbortSignal) => {
    setZonesLoading(true);
    setZoneError("");
    try {
      const response = await fetch("/api/zones", { cache: "no-store", signal });
      const result = await readResponse<OrganizationZone[]>(response, signal);
      if (!signal?.aborted) setZones(result);
    } catch (loadError) {
      if (!signal?.aborted) setZoneError(errorMessage(loadError));
    } finally {
      if (!signal?.aborted) setZonesLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMessage("");
    void dataService.queryRegistrySubjects({
      kind,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: appliedSearch || undefined,
    }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPageData(result);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(loadError));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [kind, page, appliedSearch, refreshKey]);

  const rows = useMemo(() => (pageData?.items ?? []) as SubjectRow[], [pageData]);
  const totalPages = Math.max(1, Math.ceil((pageData?.total ?? 0) / PAGE_SIZE));
  const selectedActiveZones = useMemo(() => new Set(zones.map((zone) => zone.id)), [zones]);
  const draftChanged = selected !== null && JSON.stringify(orderedZoneIds(draftZones)) !==
    JSON.stringify(orderedZoneIds(selected.allowedZones.filter((zoneId) => selectedActiveZones.has(zoneId))));

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setAppliedSearch(search.trim());
  }

  function changeKind(nextKind: SubjectKind) {
    setKind(nextKind);
    setPage(0);
    setSelected(null);
  }

  function editZones(subject: SubjectRow) {
    setSelected(subject);
    setDraftZones(subject.allowedZones.filter((zoneId) => selectedActiveZones.has(zoneId)));
    setDialogError("");
  }

  async function saveZones() {
    if (!selected || saving || !draftChanged) return;
    setSaving(true);
    setDialogError("");
    setMessage("");
    try {
      const patch = { allowedZones: orderedZoneIds(draftZones) };
      const updated = kind === "employee"
        ? await dataService.updatePerson(selected.id, patch)
        : await dataService.updateHardwareAsset(selected.id, patch);
      const updatedRow = updated as RegistrySubjectPage["items"][number];
      setPageData((current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === updatedRow.id ? updatedRow : item),
      } : current);
      setMessage(`Zone assignment saved for ${selected.name}.`);
      setSelected(null);
    } catch (saveError) {
      setDialogError(saveError instanceof DataServiceError ? saveError.message : errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const recordLabel = kind === "employee" ? "employees" : "hardware assets";
  const pageTitle = fixedKind === "employee" ? "Employee zone access" : fixedKind === "hardware" ? "Hardware zone access" : "Zone assignments";

  return <main className={styles.page} aria-label={pageTitle}>
    <header className={styles.header}>
      <div>
        <h1>{pageTitle}</h1>
        <p>{fixedKind === "employee"
          ? "Assign the organization zones each employee is allowed to enter. Checkpoint rules still apply within each zone."
          : fixedKind === "hardware"
            ? "Assign the organization zones each hardware asset is allowed to serve. Checkpoint rules still apply within each zone."
            : "Choose which organization zones each employee or hardware asset is authorized to use."}</p>
      </div>
      <button className={styles.refreshButton} type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading || zonesLoading}>
        <RotateCw size={17} aria-hidden="true" /> Refresh
      </button>
    </header>

    <section className={styles.directory} aria-labelledby="directory-title">
      <div className={styles.directoryHeader}>
        <div className={styles.directoryTitle}>
          <div><h2 id="directory-title">{fixedKind === "employee" ? "Employees" : fixedKind === "hardware" ? "Hardware assets" : "People and assets"}</h2><p>Zone membership limits the areas where access grants can apply.</p></div>
          <span className={styles.count}>{pageData?.total ?? "—"}</span>
        </div>
        <div className={styles.toolbar}>
          {!fixedKind ? <div className={styles.tabs} role="tablist" aria-label="Record type">
            <button type="button" role="tab" aria-selected={kind === "employee"} onClick={() => changeKind("employee")}>
              <UsersRound size={17} aria-hidden="true" /> Employees
            </button>
            <button type="button" role="tab" aria-selected={kind === "hardware"} onClick={() => changeKind("hardware")}>
              <Cpu size={17} aria-hidden="true" /> Hardware
            </button>
          </div> : null}
          <form className={styles.search} onSubmit={submitSearch} role="search">
            <Search size={17} aria-hidden="true" />
            <input aria-label={`Search ${kind === "employee" ? "employees" : "hardware"}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={kind === "employee" ? "Name or barcode" : "Name, barcode, or category"} maxLength={200} />
            <button type="submit" aria-label="Search records"><Search size={16} aria-hidden="true" /></button>
          </form>
        </div>
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {zoneError ? <p className={styles.error} role="alert">Unable to load organization zones: {zoneError}</p> : null}
      {message ? <p className={styles.success} role="status"><Check size={16} aria-hidden="true" />{message}</p> : null}
      {zonesLoading ? <p className={styles.loading}><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" /> Loading organization zones…</p> : null}
      {!zonesLoading && zones.length === 0 && !zoneError ? <p className={styles.emptyZones}>Create an organization zone before assigning access.</p> : null}

      <div className={styles.rows} aria-live="polite" aria-busy={loading}>
        {loading ? <p className={styles.loading}><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" /> Loading {kind === "employee" ? "employees" : "hardware"}…</p> : null}
        {!loading && rows.length === 0 && !error ? <div className={styles.empty}>
          <span><MapPin size={22} aria-hidden="true" /></span>
          <h3>{appliedSearch ? "No matching records" : `No ${recordLabel} found`}</h3>
          <p>{appliedSearch ? "Try another name or barcode." : "Registered records will appear here, including records without a zone assignment."}</p>
        </div> : null}
        {!loading ? rows.map((subject) => {
          const assigned = subject.allowedZones ?? [];
          const labels = assigned.map((id) => zones.find((zone) => zone.id === id)?.name ?? id);
          return <article className={styles.subjectRow} key={subject.id}>
            <div className={styles.identity}>
              <span className={styles.subjectIcon}>{kind === "employee" ? <UsersRound size={19} aria-hidden="true" /> : <Cpu size={19} aria-hidden="true" />}</span>
              <div><h3>{subject.name || "Unnamed record"}</h3><p>{subject.barcode}{kind === "hardware" && subject.category ? ` · ${subject.category}` : ""}</p></div>
            </div>
            <div className={styles.assignment}>
              <span className={styles.assignmentLabel}>{assigned.length ? `${assigned.length} ${assigned.length === 1 ? "zone" : "zones"} assigned` : "No zones assigned"}</span>
              {labels.length ? <div className={styles.zoneTags}>{labels.map((label, index) => <span className={styles.zoneTag} key={`${assigned[index]}-${label}`}><MapPin size={13} aria-hidden="true" />{label}</span>)}</div> : <span className={styles.unassigned}>No zone access</span>}
            </div>
            <button className={styles.editButton} type="button" onClick={() => editZones(subject)} disabled={zonesLoading || zones.length === 0}>
              <MapPin size={16} aria-hidden="true" /> Assign zones
            </button>
          </article>;
        }) : null}
      </div>

      {pageData && pageData.total > PAGE_SIZE ? <nav className={styles.pagination} aria-label="Record pages">
        <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, pageData.total)} of {pageData.total}</span>
        <div>
          <button type="button" aria-label="Previous page" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0 || loading}><ChevronLeft size={19} aria-hidden="true" /></button>
          <span>Page {page + 1} of {totalPages}</span>
          <button type="button" aria-label="Next page" onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))} disabled={page + 1 >= totalPages || loading}><ChevronRight size={19} aria-hidden="true" /></button>
        </div>
      </nav> : null}
    </section>

    {selected ? <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setSelected(null); }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="assign-title">
        <header className={styles.dialogHeader}>
          <div><span className={styles.dialogIcon}><MapPin size={20} aria-hidden="true" /></span><div><h2 id="assign-title">Assign zones</h2><p>{selected.name} <span>·</span> {selected.barcode}</p></div></div>
          <button className={styles.closeButton} type="button" aria-label="Close zone assignment" onClick={() => setSelected(null)} disabled={saving}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className={styles.dialogBody}>
          <p className={styles.scopeNote}>Select every zone this {kind === "employee" ? "employee" : "asset"} may access. Existing checkpoint-level restrictions remain in effect.</p>
          {dialogError ? <p className={styles.error} role="alert">{dialogError}</p> : null}
          {zones.length ? <div className={styles.zoneChoices}>
            {zones.map((zone) => {
              const checked = draftZones.includes(zone.id);
              const checkpoints = zone.checkpoints.map((checkpoint) => checkpoint.gateLabel || checkpoint.name).filter(Boolean);
              return <label className={styles.zoneChoice} key={zone.id} data-selected={checked}>
                <input type="checkbox" checked={checked} onChange={(event) => setDraftZones((current) => event.target.checked
                  ? [...current, zone.id]
                  : current.filter((id) => id !== zone.id))} />
                <span className={styles.customCheck}>{checked ? <Check size={14} aria-hidden="true" /> : null}</span>
                <span className={styles.zoneChoiceText}><strong>{zone.name}</strong><small>{checkpoints.length ? `${checkpoints.length} active ${checkpoints.length === 1 ? "checkpoint" : "checkpoints"} · ${checkpoints.join(", ")}` : "No active checkpoints"}</small></span>
                <span className={styles.zoneChoiceCount}>{checkpoints.length}</span>
              </label>;
            })}
          </div> : <p className={styles.emptyZones}>No active zones are available.</p>}
          {selected.allowedZones.some((id) => !selectedActiveZones.has(id)) ? <p className={styles.retiredNote}>This record includes a zone that is no longer active. Saving will replace it with the active zones selected above.</p> : null}
        </div>
        <footer className={styles.dialogFooter}>
          <span>{draftZones.length} {draftZones.length === 1 ? "zone" : "zones"} selected</span>
          <div><button className={styles.cancelButton} type="button" onClick={() => setSelected(null)} disabled={saving}>Cancel</button>
            <button className={styles.saveButton} type="button" onClick={() => void saveZones()} disabled={saving || !draftChanged}>
              {saving ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {saving ? "Saving…" : "Save assignment"}
            </button></div>
        </footer>
      </section>
    </div> : null}
  </main>;
}
