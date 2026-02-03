let people = JSON.parse(localStorage.getItem("people")) || [];
let transactions = JSON.parse(localStorage.getItem("transactions")) || [];
let savings = JSON.parse(localStorage.getItem("savings")) || {};
let directDebts = JSON.parse(localStorage.getItem("directDebts")) || [];
let currentSplitType = "";

// All monetary values are stored in cents to avoid floating-point precision issues
function formatAmount(cents) {
  if (isNaN(cents)) return "0.00";
  const dollars = cents / 100;
  return dollars.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Helper to convert dollars to cents
function toCents(dollars) {
  return Math.round(parseFloat(dollars) * 100);
}

// Helper to convert cents to dollars
function toDollars(cents) {
  return cents / 100;
}

function saveData() {
  localStorage.setItem("people", JSON.stringify(people));
  localStorage.setItem("transactions", JSON.stringify(transactions));
  localStorage.setItem("savings", JSON.stringify(savings));
  localStorage.setItem("directDebts", JSON.stringify(directDebts));
  render();
}

function render() {
  renderPeople();
  renderTransactions();
  renderDirectDebts();
  renderBalances();
  renderSummary();
  renderTotalSummary();
}

function addPerson() {
  const input = document.getElementById("newPerson");
  const name = input.value.trim();
  if (!name) { alert("Please enter a name"); return; }
  if (people.includes(name)) { alert("Person already exists"); return; }
  people.push(name); saveData(); input.value = "";
}

function removePerson(name) {
  if (confirm(`Remove ${name}? This will affect existing transactions and direct debts.`)) {
    people = people.filter(p => p !== name);
    transactions = transactions.filter(t => t.payer !== name);
    directDebts = directDebts.filter(d => d.from !== name && d.to !== name);
    if (savings[name] !== undefined) delete savings[name];
    saveData();
  }
}

function deleteTransaction(index) {
  if (confirm("Delete this transaction?")) {
    transactions.splice(index, 1);
    saveData();
  }
}

function renderPeople() {
  const container = document.getElementById("peopleList");
  const payerSelect = document.getElementById("payer");
  const directDebtFromSelect = document.getElementById("directDebtFrom");
  const directDebtToSelect = document.getElementById("directDebtTo");
  container.innerHTML = ""; payerSelect.innerHTML = ""; directDebtFromSelect.innerHTML = ""; directDebtToSelect.innerHTML = "";
  const placeholderOption = document.createElement("option");
  placeholderOption.value = ""; placeholderOption.textContent = "-- Select Person --"; placeholderOption.disabled = true; placeholderOption.selected = true; payerSelect.appendChild(placeholderOption);
  const fromPlaceholder = document.createElement("option");
  fromPlaceholder.value = ""; fromPlaceholder.textContent = "-- Select Debtor --"; fromPlaceholder.disabled = true; fromPlaceholder.selected = true; directDebtFromSelect.appendChild(fromPlaceholder);
  const toPlaceholder = document.createElement("option");
  toPlaceholder.value = ""; toPlaceholder.textContent = "-- Select Creditor --"; toPlaceholder.disabled = true; toPlaceholder.selected = true; directDebtToSelect.appendChild(toPlaceholder);
  if (people.length === 0) { container.innerHTML = '<div class="no-data">No people added yet</div>'; renderContributions(); return; }
  people.forEach(p => {
    const tag = document.createElement("div"); tag.className = "person-tag";
    tag.innerHTML = `\n          ${p}\n          <button onclick="removePerson('${p}')" type="button">×</button>\n        `;
    container.appendChild(tag);
    const option = document.createElement("option"); option.value = p; option.textContent = p; payerSelect.appendChild(option);
    const fromOption = document.createElement("option"); fromOption.value = p; fromOption.textContent = p; directDebtFromSelect.appendChild(fromOption);
    const toOption = document.createElement("option"); toOption.value = p; toOption.textContent = p; directDebtToSelect.appendChild(toOption);
  });
  if (currentSplitType) setSplitType(currentSplitType); else renderContributions();
}

function setSplitType(type) {
  currentSplitType = type;
  document.getElementById("splitEqualBtn").classList.toggle("active", type === "equal");
  document.getElementById("splitCustomBtn").classList.toggle("active", type === "custom");
  document.getElementById("splitCustomContribBtn").classList.toggle("active", type === "custom-contrib");
  document.getElementById("splitTypeError").style.display = "none";
  const payerSelect = document.getElementById("payer");
  if (type === "custom") payerSelect.setAttribute("required", "required"); else payerSelect.removeAttribute("required");
  renderContributions();
}

function renderContributions() {
  const container = document.getElementById("contributionsContainer"); container.innerHTML = "";
  if (!currentSplitType) container.innerHTML = '<p style="text-align: center; color: #999; font-style: italic;">Select a split method above to continue</p>';
  else if (currentSplitType === "equal") container.innerHTML = '<p style="text-align: center; color: #666;">Amount will be split equally among all people</p>';
  else if (currentSplitType === "custom") container.innerHTML = '<p style="text-align: center; color: #666;">Amount will be split equally among all except the payer who paid it</p>';
  else if (currentSplitType === "custom-contrib") { people.forEach(p => { const div = document.createElement("div"); div.className = "contribution-input"; div.innerHTML = `\n            <label>${p}:</label>\n            <input type="number" data-person="${p}" placeholder="0.00" step="0.01" min="0">\n          `; container.appendChild(div); }); }
}

document.getElementById("transactionForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentSplitType || currentSplitType === "") { document.getElementById("splitTypeError").style.display = "block"; return; }
  if (people.length === 0) { alert("Please add at least one person"); return; }
  const amountDollars = parseFloat(document.getElementById("amount").value);
  const description = document.getElementById("description").value;
  const payerSelect = document.getElementById("payer"); const payer = payerSelect.value;
  if (!amountDollars || amountDollars <= 0) { alert("Please enter a valid amount"); return; }
  if (currentSplitType === "custom" && !payer) { alert("Please select who paid"); return; }
  const amountCents = toCents(amountDollars);
  let contributions = {}; people.forEach(p => contributions[p] = 0);
  if (currentSplitType === "equal") {
    const baseCents = Math.floor(amountCents / people.length);
    let remainderCents = amountCents - baseCents * people.length;
    people.forEach((p, index) => {
      contributions[p] = baseCents;
      if (index < remainderCents) contributions[p] += 1;
    });
  } else if (currentSplitType === "custom") {
    people.forEach(p => contributions[p] = 0);
    contributions[payer] = amountCents;
  } else if (currentSplitType === "custom-contrib") {
    let totalContribCents = 0;
    const inputs = document.querySelectorAll("#contributionsContainer input");
    inputs.forEach(input => {
      const valueDollars = parseFloat(input.value) || 0;
      const valueCents = toCents(valueDollars);
      contributions[input.dataset.person] = valueCents;
      totalContribCents += valueCents;
    });
    if (totalContribCents <= 0) { alert("At least one person must contribute a positive amount"); return; }
    if (Math.abs(totalContribCents - amountCents) > 0) { alert(`Total of contributions (${formatAmount(totalContribCents)}) does not match amount (${formatAmount(amountCents)}). Please adjust inputs.`); return; }
  }
  const transaction = { id: Date.now(), date: new Date().toLocaleString(), amount: amountCents, description, payer, contributions };
  people.forEach(p => { if (savings[p] === undefined) savings[p] = 0; });
  const cnt = people.length;
  const baseCents = cnt > 0 ? Math.floor(amountCents / cnt) : 0;
  let remainderCents = cnt > 0 ? amountCents - baseCents * cnt : 0;
  const owedShare = {};
  people.forEach((p, index) => {
    owedShare[p] = baseCents;
    if (index < remainderCents) owedShare[p] += 1;
  });
  people.forEach(p => {
    const paidCents = contributions[p] || 0;
    const overCents = paidCents - owedShare[p];
    if (overCents > 0) {
      savings[p] = (savings[p] || 0) + overCents;
    }
  });
  transactions.push(transaction); saveData(); document.getElementById("transactionForm").reset(); setSplitType("equal");
});

document.getElementById("directDebtForm").addEventListener("submit", e => {
  e.preventDefault();
  addDirectDebt();
});

function renderTransactions() {
  const tbody = document.querySelector("#transactionTable tbody"); tbody.innerHTML = "";
  if (transactions.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="no-data">No transactions yet</td></tr>'; return; }
  const sortedTransactions = [...transactions].reverse();
  sortedTransactions.forEach((t) => {
    const splitDetails = people.map(p => `${p}: ${formatAmount(t.contributions[p] || 0)}`).join(" | ");
    const transactionIndex = transactions.findIndex(tx => tx.id === t.id);
    const row = document.createElement("tr");
    row.innerHTML = `\n          <td>${t.date}</td>\n          <td>${t.description}</td>\n          <td>${formatAmount(t.amount)}</td>\n          <td>${t.payer ? `<strong>${t.payer}</strong>` : '<em>-</em>'}</td>\n          <td style="text-align: left; font-size: 0.9rem;">${splitDetails}</td>\n          <td><button class="delete-btn" onclick="deleteTransaction(${transactionIndex})">Delete</button></td>\n        `;
    tbody.appendChild(row);
  });
}

function renderDirectDebts() {
  const tbody = document.querySelector("#directDebtTable tbody"); tbody.innerHTML = "";
  if (directDebts.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="no-data">No direct debts yet</td></tr>'; return; }
  const sortedDebts = [...directDebts].reverse();
  sortedDebts.forEach((d, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `\n          <td>${d.date}</td>\n          <td><strong>${d.from}</strong></td>\n          <td><strong>${d.to}</strong></td>\n          <td>${formatAmount(d.amount)}</td>\n          <td>${d.description || '<em>-</em>'}</td>\n          <td><button class="delete-btn" onclick="deleteDirectDebt(${directDebts.findIndex(dd => dd.id === d.id)})">Delete</button></td>\n        `;
    tbody.appendChild(row);
  });
}

function renderBalances() {
  const tbody = document.querySelector("#balanceTable tbody"); tbody.innerHTML = "";
  if (transactions.length === 0 && directDebts.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="no-data">No transactions or debts yet</td></tr>'; return; }
  let paid = {}; let shouldPay = {}; people.forEach(p => { paid[p] = 0; shouldPay[p] = 0; });
  transactions.forEach(t => {
    people.forEach(p => { paid[p] += t.contributions[p] || 0; });
    const count = people.length;
    if (count > 0) {
      const baseCents = Math.floor(t.amount / count);
      let remainderCents = t.amount - baseCents * count;
      people.forEach((p, index) => {
        let share = baseCents;
        if (index < remainderCents) share += 1;
        shouldPay[p] += share;
      });
    }
  });
  let net = {}; people.forEach(p => { net[p] = paid[p] - shouldPay[p]; });
  // Include direct debts in net balance
  directDebts.forEach(d => {
    net[d.from] = (net[d.from] || 0) - d.amount; // Debtor owes more
    net[d.to] = (net[d.to] || 0) + d.amount; // Creditor owes less
  });
  const rawDebts = calculateDebts(net); const debts = applySavingsToDebts(net, rawDebts);
  if (debts.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #28a745; font-weight: bold;">All settled! ✓</td></tr>'; return; }
  debts.forEach(d => { const row = document.createElement("tr"); row.innerHTML = `\n          <td><strong>${d.from}</strong></td>\n          <td><strong>${d.to}</strong></td>\n          <td style="color: #ff6b6b; font-weight: bold;">${formatAmount(d.amount)}</td>\n          <td><button class="paid-btn" onclick="markDebtPaid('${d.from}', '${d.to}', ${d.amount})">Mark Paid</button></td>\n        `; tbody.appendChild(row); });
}

function calculateDebts(net) {
  const debts = []; const netCopy = {};
  people.forEach(p => { netCopy[p] = net[p]; });
  const creditors = people.filter(p => netCopy[p] > 0).sort((a, b) => netCopy[b] - netCopy[a]);
  const debtors = people.filter(p => netCopy[p] < 0).sort((a, b) => netCopy[a] - netCopy[b]);
  let creditorIdx = 0; let debtorIdx = 0;
  while (creditorIdx < creditors.length && debtorIdx < debtors.length) {
    const creditor = creditors[creditorIdx]; const debtor = debtors[debtorIdx];
    const creditorAmount = Math.abs(netCopy[creditor]);
    const debtorAmount = Math.abs(netCopy[debtor]);
    const amount = Math.min(creditorAmount, debtorAmount);
    debts.push({ from: debtor, to: creditor, amount: amount });
    netCopy[creditor] -= amount;
    netCopy[debtor] += amount;
    if (netCopy[creditor] <= 0) creditorIdx++; if (netCopy[debtor] >= 0) debtorIdx++;
  }
  return debts;
}

function applySavingsToDebts(net, rawDebts) {
  const debts = rawDebts.map(d => ({ ...d })); const localSavings = {}; people.forEach(p => localSavings[p] = toDollars(savings[p] || 0));
  const debtors = [...new Set(debts.map(d => d.from))];
  debtors.forEach(debtor => { let avail = localSavings[debtor] || 0; if (avail <= 0) return; const outs = debts.filter(d => d.from === debtor && d.amount > 0); if (outs.length === 0) return; const per = avail / outs.length; outs.forEach(d => { if (avail <= 0) return; const applyAmt = Math.min(per, d.amount, avail); d.amount -= applyAmt; avail -= applyAmt; }); localSavings[debtor] = avail; });
  const cleaned = debts.filter(d => d.amount > 0);
  people.forEach(p => { const before = toDollars(savings[p] || 0); const after = localSavings[p] || 0; if (Math.abs(after - before) > 0.001) { savings[p] = toCents(after); } });
  localStorage.setItem("savings", JSON.stringify(savings));
  return cleaned;
}

function renderSummary() {
  const totalExpensesCents = transactions.reduce((sum, t) => sum + t.amount, 0);
  const fairShareCents = people.length ? Math.floor(totalExpensesCents / people.length) : 0;
  document.getElementById("totalExpenses").textContent = formatAmount(totalExpensesCents);
  document.getElementById("fairShare").textContent = formatAmount(fairShareCents);
  const paid = {}; const shouldPay = {}; people.forEach(p => { paid[p] = 0; shouldPay[p] = 0; });
  transactions.forEach(t => {
    people.forEach(p => { paid[p] += t.contributions[p] || 0; });
    const cnt = people.length;
    if (cnt > 0) {
      const baseCents = Math.floor(t.amount / cnt);
      let remainderCents = t.amount - baseCents * cnt;
      people.forEach((p, index) => {
        let share = baseCents;
        if (index < remainderCents) share += 1;
        shouldPay[p] += share;
      });
    }
  });
  let net = {}; people.forEach(p => { net[p] = paid[p] - shouldPay[p]; });
  // Include direct debts in net balance for summary
  directDebts.forEach(d => {
    net[d.from] = (net[d.from] || 0) - d.amount;
    net[d.to] = (net[d.to] || 0) + d.amount;
  });
  const tbody = document.querySelector("#summaryTable tbody"); tbody.innerHTML = "";
  if (people.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="no-data">No people added</td></tr>'; return; }
  people.forEach(p => {
    const personPaidCents = paid[p] || 0;
    const personShareCents = shouldPay[p] || 0;
    const balanceCents = net[p] || 0;
    let balanceClass = "color: #666";
    let balanceText = formatAmount(balanceCents);
    let status = "Balanced";
    if (balanceCents > 0) { balanceClass = "color: #28a745"; balanceText = `+${formatAmount(balanceCents)}`; status = "Overpaid"; }
    else if (balanceCents < 0) { balanceClass = "color: #ff6b6b"; balanceText = formatAmount(balanceCents); status = "Underpaid"; }
    const row = document.createElement("tr");
    row.innerHTML = `\n          <td><strong>${p}</strong></td>\n          <td>${formatAmount(personPaidCents)}</td>\n          <td>${formatAmount(personShareCents)}</td>\n          <td style="${balanceClass}; font-weight: bold;">${balanceText}</td>\n          <td>${status}</td>\n        `;
    tbody.appendChild(row);
  });
  renderLedger(paid, shouldPay);
}

function renderLedger(paid, shouldPay) {
  const tbody = document.querySelector("#ledgerTable tbody"); tbody.innerHTML = ""; if (people.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="no-data">No data</td></tr>'; return; } people.forEach(p => { const paidAmount = paid[p] || 0; const shouldPayAmount = shouldPay[p] || 0; const difference = paidAmount - shouldPayAmount; const row = document.createElement("tr"); let diffClass = "color: #666"; if (difference > 0) diffClass = "color: #28a745"; else if (difference < 0) diffClass = "color: #ff6b6b"; row.innerHTML = `\n          <td><strong>${p}</strong></td>\n          <td>${formatAmount(paidAmount)}</td>\n          <td>${formatAmount(shouldPayAmount)}</td>\n          <td style="${diffClass}; font-weight: bold;">${formatAmount(difference)}</td>\n        `; tbody.appendChild(row); }); }

function auditReconciliation() {
  const audit = { isValid: true, totalExpenses: 0, totalPaid: 0, totalContributions: 0, discrepancies: [] };
  audit.totalExpenses = transactions.reduce((sum, t) => sum + t.amount, 0);
  let totalContribByPerson = {}; transactions.forEach(t => { people.forEach(p => { totalContribByPerson[p] = (totalContribByPerson[p] || 0) + (t.contributions[p] || 0); }); });
  audit.totalContributions = Object.values(totalContribByPerson).reduce((sum, v) => sum + v, 0);
  audit.totalPaid = audit.totalContributions;
  const diff = audit.totalContributions - audit.totalExpenses;
  if (Math.abs(diff) > 0) { if (diff > 0) audit.discrepancies.push(`Advances present: ${formatAmount(diff)}`); else audit.discrepancies.push(`Deficit present: ${formatAmount(-diff)}`); }
  return audit;
}

function renderTotalSummary() {
  const audit = auditReconciliation();
  const totalExpensesCents = transactions.reduce((sum, t) => sum + t.amount, 0);
  const totalPaidByPerson = {}; people.forEach(p => totalPaidByPerson[p] = 0);
  transactions.forEach(t => { people.forEach(p => { totalPaidByPerson[p] += t.contributions[p] || 0; }); });
  let paid = {}; let shouldPay = {}; people.forEach(p => { paid[p] = 0; shouldPay[p] = 0; });
  transactions.forEach(t => {
    people.forEach(p => { paid[p] += t.contributions[p] || 0; });
    const cnt = people.length;
    if (cnt > 0) {
      const baseCents = Math.floor(t.amount / cnt);
      let remainderCents = t.amount - baseCents * cnt;
      people.forEach((p, index) => {
        let share = baseCents;
        if (index < remainderCents) share += 1;
        shouldPay[p] += share;
      });
    }
  });
  let net = {}; people.forEach(p => { net[p] = paid[p] - shouldPay[p]; });
  const rawDebts = calculateDebts(net); const debts = applySavingsToDebts(net, rawDebts);
  const totalDebtsCents = debts.reduce((sum, d) => sum + d.amount, 0);
  let paidHTML = "";
  if (Object.values(totalPaidByPerson).every(v => v === 0)) {
    paidHTML = '<p style="text-align: center; opacity: 0.8;">No transactions yet</p>';
  } else {
    paidHTML = people.filter(p => totalPaidByPerson[p] > 0).sort((a, b) => totalPaidByPerson[b] - totalPaidByPerson[a]).map(p => {
      const save = savings[p] ? ` <span style="opacity:.8">(Savings: ${formatAmount(savings[p])})</span>` : "";
      return `<div><span>${p}:</span> <strong>${formatAmount(totalPaidByPerson[p])}</strong>${save}</div>`;
    }).join("");
    const totalSavingsCents = Object.values(savings || {}).reduce((s, v) => s + v, 0);
    paidHTML += `<div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 8px;"><span>Total:</span> <strong>${formatAmount(totalExpensesCents)}</strong></div>`;
    if (totalSavingsCents > 0) paidHTML += `<div style="margin-top: 6px; font-size:0.9rem; opacity:0.9;"><span>Total Savings:</span> <strong>${formatAmount(totalSavingsCents)}</strong></div>`;
  }
  document.getElementById("totalPaidSummary").innerHTML = paidHTML;
  let debtHTML = "";
  if (debts.length === 0) debtHTML = '<p style="text-align: center; opacity: 0.8; color: #90EE90;">✓ All settled!</p>';
  else {
    debtHTML = debts.map(d => `<div><span>${d.from} → ${d.to}:</span> <strong>${formatAmount(d.amount)}</strong></div>`).join("");
    debtHTML += `<div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 8px;"><span>Total Debt:</span> <strong>${formatAmount(totalDebtsCents)}</strong></div>`;
  }
  if (audit.isValid) debtHTML += `<div style="margin-top: 10px; padding-top: 8px; text-align: center; color: #90EE90; font-weight: bold;">✓ Audit: VALID & RECONCILED</div>`;
  else debtHTML += `<div style="margin-top: 10px; padding-top: 8px; text-align: center; color: #ff9999; font-weight: bold;">⚠ Audit Issues: ${audit.discrepancies.join(", ")}</div>`;
  document.getElementById("totalDebtSummary").innerHTML = debtHTML;
}

function addDirectDebt() {
  const fromSelect = document.getElementById("directDebtFrom");
  const toSelect = document.getElementById("directDebtTo");
  const amountInput = document.getElementById("directDebtAmount");
  const descriptionInput = document.getElementById("directDebtDescription");
  const from = fromSelect.value;
  const to = toSelect.value;
  const amountDollars = parseFloat(amountInput.value);
  const description = descriptionInput.value.trim();
  if (!from || !to || !amountDollars || amountDollars <= 0) {
    alert("Please fill all fields with valid values");
    return;
  }
  if (from === to) {
    alert("Debtor and creditor cannot be the same person");
    return;
  }
  const amountCents = toCents(amountDollars);
  const debt = { id: Date.now(), from, to, amount: amountCents, description, date: new Date().toLocaleString() };
  directDebts.push(debt);
  saveData();
  fromSelect.value = "";
  toSelect.value = "";
  amountInput.value = "";
  descriptionInput.value = "";
}

function deleteDirectDebt(index) {
  if (confirm("Delete this direct debt?")) {
    directDebts.splice(index, 1);
    saveData();
  }
}

function markDebtPaid(from, to, maxAmount) {
  const paymentAmount = prompt(`Enter payment amount from ${from} to ${to} (max: ${formatAmount(maxAmount)}):`, formatAmount(maxAmount));
  if (paymentAmount === null) return; // User cancelled
  
  const amountDollars = parseFloat(paymentAmount);
  if (isNaN(amountDollars) || amountDollars <= 0) {
    alert("Please enter a valid positive amount.");
    return;
  }
  
  const amountCents = toCents(amountDollars);
  if (amountCents > maxAmount) {
    alert(`Payment amount cannot exceed ${formatAmount(maxAmount)}.`);
    return;
  }
  
  if (confirm(`Mark payment of ${formatAmount(amountCents)} from ${from} to ${to} as completed?`)) {
    // Add a direct debt in the opposite direction to offset the settlement
    const debt = {
      id: Date.now(),
      from: to, // Creditor becomes debtor
      to: from, // Debtor becomes creditor
      amount: amountCents,
      description: `Payment received from ${from}`,
      date: new Date().toLocaleString()
    };
    directDebts.push(debt);
    saveData();
    alert(`Payment of ${formatAmount(amountCents)} marked as completed. ${to} now owes ${from} ${formatAmount(amountCents)}.`);
  }
}

function clearAllData() { if (confirm("Are you sure you want to delete ALL data? This cannot be undone!")) { if (confirm("Really sure? This will delete all people and transactions.")) { people = []; transactions = []; directDebts = []; saveData(); } } }

function exportData() { const data = { people, transactions, savings, directDebts, exportedAt: new Date().toLocaleString() }; const json = JSON.stringify(data, null, 2); const blob = new Blob([json], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `auditing-export-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); }

function importData(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = function(e) { try { const data = JSON.parse(e.target.result); if (!data.people || !Array.isArray(data.people) || !data.transactions || !Array.isArray(data.transactions)) { alert("Invalid file format. Please import a valid auditing export file."); return; } if (confirm("This will replace all existing data. Continue?")) { people = data.people; transactions = data.transactions; savings = data.savings || {}; directDebts = data.directDebts || []; saveData(); alert("Data imported successfully!"); document.getElementById("importFile").value = ""; } } catch (error) { alert("Error reading file: " + error.message); } }; reader.readAsText(file); }

// initial render
render();