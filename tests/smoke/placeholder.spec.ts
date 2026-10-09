import { test, expect } from "@playwright/test";

test.describe("Phase 0 Placeholder Service Smoke Tests", () => {
  test("root page renders with RUO banner", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/CellWeave/);
    const ruoBanner = page.getByText(/Research Use Only/i).first();
    await expect(ruoBanner).toBeVisible();
    const heading = page.getByRole("heading", { name: "CellWeave" });
    await expect(heading).toBeVisible();
  });

  test("health endpoint returns operational status", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.ruo).toBe(true);
    expect(body.service).toBe("cellweave-web");
  });

  test("api/v1 health endpoint returns operational status", async ({ request }) => {
    const response = await request.get("/api/v1/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.phase).toBe("Phase 0 — Foundations");
  });
});
