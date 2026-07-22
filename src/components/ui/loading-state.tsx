export function ModuleLoading({ kind = "chart" }: { kind?: "chart" | "table" | "form" }) {
  return <section className="module-loading" aria-busy="true" aria-label="Sayfa yükleniyor">
    <span className="sr-only">Sayfa yükleniyor</span>
    <div className="loading-alert skeleton-block" />
    <div className="loading-kpis">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-card" key={index}><i /><b /></div>)}</div>
    {kind === "chart" && <div className="skeleton-chart"><i /><i /><i /><i /></div>}
    {kind === "table" && <div className="skeleton-table">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div>}
    {kind === "form" && <div className="skeleton-form">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div>}
  </section>;
}
