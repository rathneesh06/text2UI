// Sidebar.tsx — the design's left rail (Figma image 4): NAVIGATION, TABLES,
// + New Project. My Projects is live now (session-local registry in App).
import { NavLink } from "react-router-dom";
import { HiOutlineFolderOpen } from "react-icons/hi";
import type { Table } from "../lib/datasets";
import "./Sidebar.css";

interface SidebarProps {
  onNewProject: () => void;
  tables: Table[];
  selectedTableName: string | null;
  onSelectTable: (table: Table) => void;
}

export default function Sidebar({ onNewProject, tables, selectedTableName, onSelectTable }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <div className="sidebar__logo">
          <span className="sidebar__logo-icon">✦</span>
          <span className="sidebar__logo-text">text2UI</span>
        </div>

        <div className="sidebar__section-label">Navigation</div>
        <nav className="sidebar__nav">
          <NavLink
            to="/projects"
            className={({ isActive }) => `sidebar__link ${isActive ? "sidebar__link--active" : ""}`}
          >
            <HiOutlineFolderOpen className="sidebar__link-icon" />
            <span>My Projects</span>
          </NavLink>
        </nav>

        <div className="sidebar__data-panel">
          <div className="sidebar__data-header">
            <span>Tables</span>
            <span className="sidebar__data-count">{tables.length} {tables.length === 1 ? "table" : "tables"}</span>
          </div>

          {tables.length > 0 ? (
            <div className="sidebar__data-list">
              {tables.map((table) => (
                <button
                  key={table.id}
                  className={`sidebar__data-item ${table.tableName === selectedTableName ? "sidebar__data-item--active" : ""}`}
                  onClick={() => onSelectTable(table)}
                  type="button"
                >
                  <div className="sidebar__data-name">{table.tableName}</div>
                  <div className="sidebar__data-meta">
                    {table.ingest.profile.rowCount.toLocaleString()} rows · {table.ingest.profile.columns.length} cols
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="sidebar__data-empty">Upload a dataset to explore its tables here.</div>
          )}
        </div>
      </div>

      <div className="sidebar__bottom">
        <button className="sidebar__new-project" onClick={onNewProject}>
          <span className="sidebar__new-icon">+</span>
          <span>New Project</span>
        </button>
      </div>
    </aside>
  );
}
