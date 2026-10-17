"use client";

import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  const { data: sessionData, isPending } = authClient.useSession();
  const [logs, setLogs] = React.useState<
    Array<{ step: string; status: "success" | "error" | "info"; detail: string }>
  >([]);
  const [createdOrgId, setCreatedOrgId] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);

  const addLog = (step: string, status: "success" | "error" | "info", detail: string) => {
    setLogs((prev) => [...prev, { step, status, detail }]);
  };

  const runAllVerifications = async () => {
    setIsRunning(true);
    setLogs([]);
    try {
      // 1. Session verification
      addLog(
        "1. Authenticated Identity",
        "info",
        `User: ${sessionData?.user?.name} (${sessionData?.user?.email}), ID: ${sessionData?.user?.id}`
      );

      // 2. Unassigned check or current active org check
      let orgId: string | null = sessionData?.session?.activeOrganizationId || null;
      if (!orgId) {
        try {
          const preOrgRes = await fetch("/api/v1/organizations/org_placeholder");
          const preOrgJson = await preOrgRes.json();
          if (preOrgRes.status === 403) {
            addLog(
              "2. Unassigned Organization Access",
              "success",
              `Correctly rejected with HTTP 403: ${preOrgJson.message}`
            );
          } else {
            addLog(
              "2. Unassigned Organization Access",
              "error",
              `Unexpected response: HTTP ${preOrgRes.status} ${JSON.stringify(preOrgJson)}`
            );
          }
        } catch (err) {
          addLog(
            "2. Unassigned Organization Access",
            "error",
            `Fetch failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // 3. Create organization via BetterAuth
        try {
          const orgSlug = `cellweave-dev-${Date.now().toString(36)}`;
          const createRes = await authClient.organization.create({
            name: "CellWeave Dev Lab",
            slug: orgSlug,
          });

          if (createRes.data && createRes.data.id) {
            orgId = createRes.data.id;
            setCreatedOrgId(orgId);
            addLog(
              "3. BetterAuth Organization Creation",
              "success",
              `Created Organization: ${createRes.data.name} (id: ${orgId}, slug: ${orgSlug})`
            );
          } else {
            addLog(
              "3. BetterAuth Organization Creation",
              "error",
              `Creation failed: ${JSON.stringify(createRes.error)}`
            );
            return;
          }
        } catch (err) {
          addLog(
            "3. BetterAuth Organization Creation",
            "error",
            `Creation threw: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        // 4. Set active organization
        try {
          const setActiveRes = await authClient.organization.setActive({
            organizationId: orgId,
          });
          if (!setActiveRes.error) {
            addLog("4. Set Active Organization", "success", `Active organization set to: ${orgId}`);
          } else {
            addLog(
              "4. Set Active Organization",
              "error",
              `Set active failed: ${JSON.stringify(setActiveRes.error)}`
            );
          }
        } catch (err) {
          addLog(
            "4. Set Active Organization",
            "error",
            `Set active threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        setCreatedOrgId(orgId);
        addLog(
          "2. Unassigned Organization Access",
          "info",
          `Session was previously verified with activeOrganizationId: ${orgId}`
        );
        addLog(
          "3. BetterAuth Organization Creation",
          "info",
          `Using existing created organization: ${orgId}`
        );
        addLog("4. Set Active Organization", "success", `Active organization confirmed: ${orgId}`);
      }

      // 5. Test TenantContext resolution on /api/v1/organizations/[orgId]
      try {
        const orgRes = await fetch(`/api/v1/organizations/${orgId}`);
        const orgJson = await orgRes.json();
        if (orgRes.status === 200 && orgJson.data) {
          addLog(
            "5. Server-Validated TenantContext",
            "success",
            `HTTP 200 OK — Org name: "${orgJson.data.name}", ID: ${orgJson.data.id}`
          );
        } else {
          addLog(
            "5. Server-Validated TenantContext",
            "error",
            `Failed with HTTP ${orgRes.status}: ${JSON.stringify(orgJson)}`
          );
        }
      } catch (err) {
        addLog(
          "5. Server-Validated TenantContext",
          "error",
          `Fetch threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 6. Test Cross-Tenant access rejection (strictly rejected with HTTP 403 / 404)
      try {
        const foreignRes = await fetch("/api/v1/organizations/org_foreign_forbidden_999");
        const foreignJson = await foreignRes.json();
        if (foreignRes.status === 403 || foreignRes.status === 404) {
          addLog(
            "6. Cross-Tenant IDOR Guard",
            "success",
            `HTTP ${foreignRes.status} Rejection: ${foreignJson.message || foreignJson.error}`
          );
        } else {
          addLog(
            "6. Cross-Tenant IDOR Guard",
            "error",
            `Expected 403/404, received HTTP ${foreignRes.status}: ${JSON.stringify(foreignJson)}`
          );
        }
      } catch (err) {
        addLog(
          "6. Cross-Tenant IDOR Guard",
          "error",
          `Fetch threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 7. Perform audited mutation (update org settings via PUT)
      try {
        const updateRes = await fetch(`/api/v1/organizations/${orgId}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            defaultRetentionDays: 90,
            projectVisibility: "private",
          }),
        });
        const updateJson = await updateRes.json();
        if (updateRes.status === 200) {
          addLog(
            "7. Audited Mutation (Settings Update)",
            "success",
            `HTTP 200 OK — Retention updated to ${updateJson.data.defaultRetentionDays} days, visibility: "${updateJson.data.projectVisibility}"`
          );
        } else {
          addLog(
            "7. Audited Mutation (Settings Update)",
            "error",
            `Failed with HTTP ${updateRes.status}: ${JSON.stringify(updateJson)}`
          );
        }
      } catch (err) {
        addLog(
          "7. Audited Mutation (Settings Update)",
          "error",
          `Fetch threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 8. Query audit events trail
      try {
        const auditRes = await fetch(`/api/v1/organizations/${orgId}/audit-events`);
        const auditJson = await auditRes.json();
        if (auditRes.status === 200 && Array.isArray(auditJson.data)) {
          addLog(
            "8. Audit Trail Verification",
            "success",
            `HTTP 200 OK — Retrieved ${auditJson.data.length} audit event(s): ${auditJson.data.map((e: { action: string }) => e.action).join(", ")}`
          );
        } else {
          addLog(
            "8. Audit Trail Verification",
            "error",
            `Failed with HTTP ${auditRes.status}: ${JSON.stringify(auditJson)}`
          );
        }
      } catch (err) {
        addLog(
          "8. Audit Trail Verification",
          "error",
          `Fetch threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-3xl">
      <h1 className="text-2xl font-bold">Phase 1 Step I-B: Live Verification Suite</h1>
      <p className="text-muted-foreground text-sm mt-1">
        End-to-end verification of Google OAuth, BetterAuth persistence, multi-tenant TenantContext
        resolution, IDOR isolation, and append-only audit logging.
      </p>

      <div className="mt-6 p-4 rounded-lg border bg-muted/20">
        <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
          Live Session State
        </h2>
        {isPending ? (
          <p className="text-sm text-muted-foreground mt-2">Checking session...</p>
        ) : sessionData?.user ? (
          <div className="text-sm mt-2 space-y-1">
            <p>
              <strong>Authenticated User:</strong> {sessionData.user.name} ({sessionData.user.email}
              )
            </p>
            <p>
              <strong>User ID:</strong>{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{sessionData.user.id}</code>
            </p>
            <p>
              <strong>Session ID:</strong>{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                {sessionData.session.id}
              </code>
            </p>
            <p>
              <strong>Active Org ID:</strong>{" "}
              {sessionData.session.activeOrganizationId || (
                <em className="text-amber-600 dark:text-amber-400">null (unassigned)</em>
              )}
            </p>
            {createdOrgId && (
              <p>
                <strong>Verified Org ID:</strong>{" "}
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{createdOrgId}</code>
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-destructive mt-2">
            No active session detected. Please sign in via /login.
          </p>
        )}
      </div>

      <div className="mt-6 flex gap-3">
        <Button onClick={runAllVerifications} disabled={isRunning || !sessionData?.user}>
          {isRunning ? "Running Verification Suite..." : "Run Step I-B Verification Suite"}
        </Button>
      </div>

      {logs.length > 0 && (
        <div className="mt-6 space-y-3">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
            Verification Results
          </h2>
          {logs.map((log, i) => (
            <div
              key={i}
              className={`p-3 rounded border text-sm ${
                log.status === "success"
                  ? "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300"
                  : log.status === "error"
                    ? "bg-destructive/10 border-destructive/30 text-destructive"
                    : "bg-muted/40 border-muted text-foreground"
              }`}
            >
              <div className="font-semibold">{log.step}</div>
              <div className="text-xs mt-1 break-words font-mono">{log.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
