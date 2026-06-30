// StyleGuidePage.tsx — /styleguide (dev route, Figma image 1).
// A living reference of the design system: buttons, inputs, tags, status
// colors, and the embedded white preview. Static by design — not linked in nav.
import "./StyleGuidePage.css";

export default function StyleGuidePage() {
  return (
    <div className="styleguide">
      <div className="styleguide__wrap">
        {/* ---- header ---- */}
        <header className="styleguide__header">
          <div className="styleguide__brand">
            <span className="styleguide__brand-icon">✦</span>
            <div>
              <div className="styleguide__brand-row">
                <span className="styleguide__brand-name">text2UI</span>
                <span className="styleguide__chip-outline">Developer Tool</span>
              </div>
              <span className="styleguide__brand-tagline">
                Turn natural-language prompts and uploaded data files into live, running dashboard apps.
              </span>
            </div>
          </div>
          <div className="styleguide__header-actions">
            <button className="sg-btn sg-btn--primary">
              <span className="sg-btn__icon">✦</span>
              Generate App
            </button>
            <button className="sg-btn sg-btn--ghost">Upload Data</button>
          </div>
        </header>

        {/* ---- Buttons ---- */}
        <section className="sg-card">
          <div className="sg-card__head">
            <div className="sg-card__head-left">
              <span className="sg-tag">Buttons</span>
              <span className="sg-path">/components/button</span>
            </div>
            <span className="styleguide__chip-outline">Glass UI</span>
          </div>
          <p className="sg-card__desc">
            Primary actions use a purple-to-cyan gradient. Secondary actions stay subtle and transparent.
          </p>

          <div className="sg-btn-stack">
            <button className="sg-btn sg-btn--primary sg-btn--block">
              <span className="sg-btn__icon">✦</span>
              Primary
            </button>
            <button className="sg-btn sg-btn--ghost-bordered sg-btn--block">Ghost</button>
            <button className="sg-btn sg-btn--destructive sg-btn--block">Destructive</button>
          </div>

          <div className="sg-prompt-box">
            <div className="sg-prompt-box__head">
              <div>
                <div className="sg-prompt-box__title">Prompt</div>
                <div className="sg-prompt-box__sub">Describe the dashboard you want</div>
              </div>
              <span className="sg-badge sg-badge--green">Live</span>
            </div>
            <div className="sg-prompt-box__area">
              Build a KPI dashboard for weekly revenue, churn, and top customers
            </div>
            <div className="sg-prompt-box__chips">
              <span className="sg-chip">CSV</span>
              <span className="sg-chip">JSON</span>
              <span className="sg-chip">Postgres</span>
              <span className="sg-chip">Supabase</span>
            </div>
          </div>
        </section>

        {/* ---- Inputs & Tags ---- */}
        <section className="sg-card">
          <div className="sg-card__head">
            <div className="sg-card__head-left">
              <span className="sg-tag">Inputs &amp; Tags</span>
              <span className="sg-path">Inter / JetBrains Mono</span>
            </div>
            <span className="styleguide__chip-outline">Status</span>
          </div>
          <p className="sg-card__desc">
            Inputs, chips, and status colors are tuned for a dark glass shell with clear hierarchy.
          </p>

          <label className="sg-label" htmlFor="sg-appname">App name</label>
          <input className="sg-input" id="sg-appname" defaultValue="Revenue Ops Dashboard" />

          <label className="sg-label sg-label--gap" htmlFor="sg-datasource">Data source</label>
          <input className="sg-input sg-input--mono" id="sg-datasource" defaultValue="sales_q4_2025.csv" />

          <div className="sg-status-chips">
            <span className="sg-status-chip"><span className="sg-dot sg-dot--g" />Success</span>
            <span className="sg-status-chip"><span className="sg-dot sg-dot--r" />Error</span>
            <span className="sg-status-chip"><span className="sg-dot sg-dot--a" />Warning</span>
          </div>
        </section>

        {/* ---- Status Colors ---- */}
        <section className="sg-card">
          <div className="sg-card__head">
            <div className="sg-card__head-left">
              <span className="sg-tag">Status Colors</span>
              <span className="sg-path">Semantic palette</span>
            </div>
            <span className="styleguide__chip-outline">Accessible</span>
          </div>
          <p className="sg-card__desc">Use semantic colors sparingly for clarity, alerts, and confirmations.</p>

          <div className="sg-sem-row">
            <div className="sg-sem-row__left">
              <span className="sg-dot sg-dot--g" />
              <div>
                <div className="sg-sem-row__title">Success</div>
                <div className="sg-sem-row__sub">Connected and synced</div>
              </div>
            </div>
            <span className="sg-sem-code sg-sem-code--ok">OK</span>
          </div>
          <div className="sg-sem-row">
            <div className="sg-sem-row__left">
              <span className="sg-dot sg-dot--r" />
              <div>
                <div className="sg-sem-row__title">Error</div>
                <div className="sg-sem-row__sub">File parsing failed</div>
              </div>
            </div>
            <span className="sg-sem-code sg-sem-code--fail">FAIL</span>
          </div>
          <div className="sg-sem-row">
            <div className="sg-sem-row__left">
              <span className="sg-dot sg-dot--a" />
              <div>
                <div className="sg-sem-row__title">Warning</div>
                <div className="sg-sem-row__sub">Missing optional column</div>
              </div>
            </div>
            <span className="sg-sem-code sg-sem-code--warn">WARN</span>
          </div>
        </section>

        {/* ---- Embedded App Preview ---- */}
        <section className="sg-card">
          <div className="sg-card__head">
            <div className="sg-card__head-left">
              <span className="sg-tag">Embedded App Preview</span>
              <span className="sg-path">Light surface inside dark shell</span>
            </div>
            <span className="styleguide__chip-outline">Preview</span>
          </div>
          <p className="sg-card__desc">
            A white embedded surface helps dashboards feel like a real running app while staying framed by the dark editor shell.
          </p>

          <div className="sg-white-preview">
            <div className="sg-white-preview__head">
              <div>
                <div className="sg-white-preview__title">Revenue Ops Dashboard</div>
                <div className="sg-white-preview__url">preview.app / live</div>
              </div>
              <span className="sg-running"><span className="sg-running__dot" />Running</span>
            </div>
            <div className="sg-kpi-stack">
              <div className="sg-kpi">
                <div className="sg-kpi__label">MRR</div>
                <div className="sg-kpi__value">$128.4k</div>
                <div className="sg-kpi__delta sg-kpi__delta--up">+12.4%</div>
              </div>
              <div className="sg-kpi">
                <div className="sg-kpi__label">Churn</div>
                <div className="sg-kpi__value">2.1%</div>
                <div className="sg-kpi__delta sg-kpi__delta--down">-0.3%</div>
              </div>
              <div className="sg-kpi">
                <div className="sg-kpi__label">Customers</div>
                <div className="sg-kpi__value">4,892</div>
                <div className="sg-kpi__delta sg-kpi__delta--up">+184</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
