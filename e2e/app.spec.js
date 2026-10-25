import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("dialog", dialog => dialog.accept(dialog.defaultValue())); // confirm()/prompt() keep their defaults
});

async function createTrip(page, name = "Bali", currency = "USD") {
  await page.goto("/");
  await page.locator('form[data-form="createTrip"] input[name="name"]').fill(name);
  await page.locator('form[data-form="createTrip"] input[name="currency"]').fill(currency);
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page.locator(".trip-head h2")).toContainText(name);
}

async function addMember(page, name) {
  await page.locator('form[data-form="addMember"] input[name="memberName"]').fill(name);
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.locator(".people-list")).toContainText(name);
}

async function addExpense(page, { amount, description, mode, payer }) {
  const form = page.locator('form[data-form="addExpense"]');
  await form.locator('input[name="amount"]').fill(amount);
  await form.locator('input[name="description"]').fill(description);
  await form.getByText(mode).click();
  if (payer) await form.locator('select[name="payerId"]').selectOption({ label: payer });
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(page.locator("table").filter({ hasText: description })).toBeVisible();
}

test("a trip is tracked end to end and survives a reload", async ({ page }) => {
  await createTrip(page);
  await addMember(page, "Ann");
  await addMember(page, "Ben");
  await addMember(page, "Cy");
  await addExpense(page, { amount: "90", description: "Hotel", mode: "One person paid", payer: "Ann" });

  const settle = page.locator(".card", { hasText: "Settle up" });
  await expect(settle).toContainText("Ben");
  await expect(settle).toContainText("$30.00");
  await expect(page.locator(".card", { hasText: "Audit" }).last()).toContainText("Valid & reconciled");

  await page.reload();
  await expect(page.locator(".card", { hasText: "Settle up" })).toContainText("$30.00");

  // Mark one debt paid with the suggested amount
  await settle.getByRole("button", { name: "Mark paid" }).first().click();
  await expect(page.locator(".card", { hasText: "Settle up" }).getByRole("button", { name: "Mark paid" })).toHaveCount(1);
  await expect(page.locator(".card", { hasText: "Debts & payments" })).toContainText("Paid");
});

test("works with no connection after the first visit", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await createTrip(page, "Offline trip", "EUR");
  await addMember(page, "Ann");
  await addMember(page, "Ben");
  // A decimal comma is understood ("10,50" = 10.50, not 1050); a malformed number is refused
  await addExpense(page, { amount: "1,2,3", description: "Typo", mode: "One person paid", payer: "Ann" }).catch(() => {});
  await expect(page.locator("#toast")).toContainText("valid amount");
  await addExpense(page, { amount: "10,50", description: "Coffee", mode: "One person paid", payer: "Ann" });
  await expect(page.locator(".card", { hasText: "Settle up" })).toContainText("5.25");

  await page.reload();
  await expect(page.locator(".trip-head h2")).toContainText("Offline trip");
  await expect(page.locator("#syncPill")).toContainText("Saved on this device");
  await context.setOffline(false);
});

test("custom amounts must add up; the running total helps", async ({ page }) => {
  await createTrip(page);
  await addMember(page, "Ann");
  await addMember(page, "Ben");
  const form = page.locator('form[data-form="addExpense"]');
  await form.locator('input[name="amount"]').fill("100");
  await form.locator('input[name="description"]').fill("Dinner");
  await form.getByText("Custom amounts").click();
  const inputs = form.locator('input[name^="contrib-"]');
  await inputs.nth(0).fill("70");
  await inputs.nth(1).fill("20");
  await expect(form.locator("[data-custom-total]")).toContainText("short by 10.00");
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(page.locator("#toast")).toContainText("add up to");
  await inputs.nth(1).fill("30");
  await expect(form.locator("[data-custom-total]")).toContainText("✓");
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(page.locator(".card", { hasText: "Settle up" })).toContainText("$20.00");
});

test("late joiners: billed from now on, or for everything since the start", async ({ page }) => {
  await createTrip(page);
  await addMember(page, "Ann");
  await addMember(page, "Ben");
  await addExpense(page, { amount: "90", description: "Hotel", mode: "One person paid", payer: "Ann" });

  await addMember(page, "Cy"); // default: only new expenses
  await page.locator('form[data-form="addMember"] input[name="memberName"]').fill("Di");
  await page.getByText("All expenses since the start of the trip").click();
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.locator(".people-list")).toContainText("Di");

  const summary = page.locator(".card", { hasText: "Summary" }).first();
  await expect(summary.locator("tr", { hasText: "Cy" })).toContainText("Settled");
  await expect(summary.locator("tr", { hasText: "Di" })).toContainText("-$30.00");
  // The radio is back on the safe default
  await expect(page.locator('input[name="billFrom"][value="join"]')).toBeChecked();
});

test("names and descriptions are shown as text, never run as code", async ({ page }) => {
  await createTrip(page, "<img src=x onerror=\"document.title='PWNED'\">");
  await addMember(page, "<b>Bold</b>");
  await expect(page.locator(".people-list")).toContainText("<b>Bold</b>");
  expect(await page.title()).not.toContain("PWNED");
  expect(await page.locator(".people-list b").count()).toBe(0);
});

test("a trip owned by another account is read-only", async ({ page }) => {
  await createTrip(page, "Shared trip");
  await addMember(page, "Ann");
  const tripId = page.url().split("/trip/")[1];
  // Simulate a trip that was shared with this device by someone else
  await page.evaluate(id => new Promise((resolve, reject) => {
    const open = indexedDB.open("travel-audit");
    open.onsuccess = () => {
      const tx = open.result.transaction("trips", "readwrite");
      const store = tx.objectStore("trips");
      store.get(id).onsuccess = e => store.put({ ...e.target.result, ownerId: "someone-else" });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), tripId);
  await page.reload();
  await expect(page.getByText("You can view this trip")).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Export trip/ })).toBeVisible();
});

test("data from the previous version is moved into a trip automatically", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("travelAudit.v2", JSON.stringify({
      schemaVersion: 2, people: ["Ann", "Ben"], formerMembers: [],
      transactions: [{ id: 1, amount: 4000, description: "Old dinner", participants: ["Ann", "Ben"], shares: [2000, 2000], contributions: { Ann: 4000, Ben: 0 } }],
      directDebts: [],
    }));
  });
  await page.goto("/");
  await expect(page.locator(".trip-list")).toContainText("Imported trip");
  await page.locator(".trip-list").getByText("Imported trip").click();
  await expect(page.locator(".card", { hasText: "Settle up" })).toContainText("$20.00");
});
