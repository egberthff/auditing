const time = iso => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const waiting = n => (n === 1 ? "1 change waiting" : `${n} changes waiting`);

export function describeSync(status) {
  switch (status.state) {
    case "local-only": return { text: "Saved on this device", kind: "muted", title: "Online sync is not configured for this app." };
    case "signed-out": return { text: status.pending ? `Not syncing · ${waiting(status.pending)}` : "Not syncing · sign in", kind: "muted", title: "Sign in to back up and sync your trips." };
    case "offline": return { text: status.pending ? `Offline · ${waiting(status.pending)}` : "Offline · all saved", kind: "warning", title: "Changes are saved on this device and will sync when you're back online." };
    case "syncing": return { text: status.detail ?? "Syncing…", kind: "info", title: "Sending, receiving and checking changes." };
    case "retrying": return { text: status.pending ? `Connection problem · ${waiting(status.pending)}` : "Connection problem", kind: "warning", title: `Will retry automatically. ${status.error?.message ?? ""}` };
    case "error": return { text: "Sync problem · tap for details", kind: "danger", title: status.error?.message ?? "" };
    case "synced": {
      const checked = status.verifiedAt && status.verifiedAt === status.lastSyncedAt;
      return {
        text: status.pending ? waiting(status.pending) : `${checked ? "Synced & checked" : "Synced"} ${time(status.lastSyncedAt)}`,
        kind: "success",
        title: checked ? "Everything is backed up, and this device was checked against the server: it holds exactly the same records." : "Everything is backed up.",
      };
    }
    default: return { text: status.pending ? waiting(status.pending) : "Ready", kind: "muted", title: "" };
  }
}

export function renderSyncPill(pill, status) {
  const { text, kind, title } = describeSync(status);
  pill.textContent = text;
  pill.className = `pill ${kind}`;
  pill.title = title;
}

export function explainSyncProblem(error) {
  if (!error) return "Sync stopped.";
  const what = error.record?.description ? ` (“${error.record.description}”)` : "";
  const fix = error.code === "42501"
    ? "The server says this account isn't allowed to change that trip."
    : `Fix or delete the record${what} and it will sync automatically.`;
  return `The server didn't accept a change${what}:\n${error.message}\n\n${fix}`;
}
