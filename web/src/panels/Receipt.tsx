import type { PanelReceipt } from "../../../src/panels/contract.js";
import { PanelGlyph } from "./Tabs.js";
import type { PanelIcon } from "../../../src/panels/contract.js";

/**
 * A pill row for one committed or rejected panel update without a call in a work group (a user action, a tool view's
 * later update). Clicking it selects its tab in the side panel.
 */
export function Receipt({ receipt, icon, onOpen, openLabel = "Show this panel in the side panel" }: {
  receipt: PanelReceipt; icon: PanelIcon; onOpen: () => void; openLabel?: string;
}) {
  return (
    <button type="button" className={`panel-receipt ${receipt.error ? "rejected" : ""}`} onClick={onOpen} title={openLabel}>
      <PanelGlyph icon={icon} size={13} />
      <span className="panel-receipt-title">{receipt.title}</span>
      {receipt.source === "user_action" && <small className="panel-tag">You</small>}
      <span className="panel-receipt-summary">
        {receipt.error ? `Update rejected: ${receipt.error.code}` : receipt.op === "close" ? "Closed" : receipt.summary}
      </span>
    </button>
  );
}
