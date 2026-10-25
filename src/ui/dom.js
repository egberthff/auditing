// Small DOM helpers shared by the views.

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function formatDateTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const fieldKey = el => {
  const form = el.closest("form")?.dataset.form ?? "";
  return `${form}:${el.name}${el.type === "radio" ? `=${el.value}` : ""}`;
};

// Re-render `container` without losing what the person is typing (sync can refresh the
// screen at any moment). Values, checked radios and the focused field are carried over.
export function renderPreservingInput(container, html) {
  const saved = new Map();
  for (const el of container.querySelectorAll("input[name], select[name], textarea[name]")) {
    if (el.type === "file" || el.dataset.noPreserve !== undefined) continue;
    saved.set(fieldKey(el), el.type === "radio" || el.type === "checkbox" ? el.checked : el.value);
  }
  const active = document.activeElement;
  const focus = active && container.contains(active) && active.name
    ? { key: fieldKey(active), start: active.selectionStart, end: active.selectionEnd }
    : null;
  const openDetails = new Set([...container.querySelectorAll("details[data-key][open]")].map(d => d.dataset.key));

  container.innerHTML = html;

  for (const el of container.querySelectorAll("input[name], select[name], textarea[name]")) {
    const key = fieldKey(el);
    if (!saved.has(key)) continue;
    if (el.type === "radio" || el.type === "checkbox") el.checked = saved.get(key);
    else if ([...(el.options ?? [])].some(o => o.value === saved.get(key)) || el.tagName !== "SELECT") el.value = saved.get(key);
  }
  for (const d of container.querySelectorAll("details[data-key]")) if (openDetails.has(d.dataset.key)) d.open = true;
  if (focus) {
    const el = [...container.querySelectorAll("input[name], select[name], textarea[name]")].find(e => fieldKey(e) === focus.key);
    if (el) {
      el.focus();
      try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
    }
  }
}

let toastTimer = null;
export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 7000 : 3500);
}

export function setBanner(id, html, kind = "warning") {
  const el = document.getElementById(id);
  el.innerHTML = html ?? "";
  el.className = `banner ${kind}`;
  el.hidden = !html;
}
