"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  QcMetricSummary,
  QcReviewView,
  QcSelectionParameters,
  QcThresholdRule,
} from "@cellweave/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { canConfirmQc, sameQcSelection } from "@/lib/qc-review";
import { isQcReviewView, qcRequest } from "@/lib/qc-client-validation";
const control =
  "min-h-11 rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const labels: Record<QcThresholdRule["metric"], string> = {
  total_counts: "Total counts",
  n_genes_by_counts: "Detected genes",
  total_counts_mt: "Mitochondrial counts",
  pct_counts_mt: "Mitochondrial percentage",
  total_counts_ribo: "Ribosomal counts",
  pct_counts_ribo: "Ribosomal percentage",
};
const display = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
export function QcHistogram({ metric }: { metric: QcMetricSummary }) {
  const maximum = Math.max(1, ...metric.histogram.map((bin) => bin.count));
  return (
    <figure className="flex flex-col gap-2 rounded-md border p-4">
      <figcaption className="font-medium">{labels[metric.metric]}</figcaption>
      <p className="text-sm">
        Mean: {display(metric.mean)} · Range: {display(metric.minimum)}–{display(metric.maximum)}
      </p>
      <p className="text-sm text-muted-foreground">
        {metric.availableCells.toLocaleString()} cells with available values
      </p>
      {metric.histogram.length > 0 ? (
        <>
          <svg
            viewBox="0 0 280 80"
            className="h-20 w-full text-primary"
            role="img"
            aria-label={labels[metric.metric] + " distribution; exact bin counts follow"}
          >
            {metric.histogram.map((bin, index) => (
              <rect
                key={index}
                x={index * 14}
                y={80 - (bin.count / maximum) * 80}
                width={12}
                height={(bin.count / maximum) * 80}
                fill="currentColor"
              />
            ))}
          </svg>
          <details>
            <summary className="cursor-pointer text-sm">Distribution data</summary>
            <table className="w-full text-sm">
              <caption className="sr-only">{labels[metric.metric]} histogram</caption>
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Cells</th>
                </tr>
              </thead>
              <tbody>
                {metric.histogram.map((bin, index) => (
                  <tr key={index}>
                    <td>{display(bin.lower)}</td>
                    <td>{display(bin.upper)}</td>
                    <td>{bin.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p>Metric unavailable; no distribution is shown.</p>
      )}
    </figure>
  );
}
export function QcReview({ runId }: { runId: string }) {
  const [view, setView] = useState<QcReviewView | null>(null);
  const [selection, setSelection] = useState<QcSelectionParameters>({
    thresholds: [],
    doubletHandling: "RETAIN",
  });
  const [metric, setMetric] = useState<QcThresholdRule["metric"]>("total_counts");
  const [sample, setSample] = useState(""),
    [minimum, setMinimum] = useState(""),
    [maximum, setMaximum] = useState("");
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [samplePage, setSamplePage] = useState(0);
  const mounted = useRef(true),
    fetching = useRef(false),
    initialized = useRef(false),
    terminal = useRef(false);
  const keys = useRef(new Map<string, string>());
  const path = "/api/v1/qc/" + encodeURIComponent(runId);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await qcRequest(path);
      if (!isQcReviewView(data)) throw new Error("Invalid QC review");
      if (mounted.current) {
        setView(data);
        terminal.current = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(data.status);
        if (!initialized.current) {
          setSelection(data.previewParameters ?? { thresholds: [], doubletHandling: "RETAIN" });
          initialized.current = true;
        }
      }
    } catch {
      if (mounted.current)
        setError("QC review could not be loaded. Check your access or refresh this page.");
    } finally {
      fetching.current = false;
    }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!terminal.current) void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    setConfirmed(false);
  }, [selection, view?.preview?.previewId]);
  async function action(operation: "preview" | "approve" | "cancel", body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const serialized = JSON.stringify(body),
        identity = operation + serialized;
      if (!keys.current.has(identity)) keys.current.set(identity, crypto.randomUUID());
      await qcRequest(path + "/" + operation, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": keys.current.get(identity) ?? "",
        },
        body: serialized,
      });
      setNotice(
        operation === "preview"
          ? "Selection preview requested. No cells have been removed."
          : operation === "approve"
            ? "Decision recorded. Filtering will use this immutable selection."
            : "Cancellation requested."
      );
      await refresh();
    } catch {
      setError(
        "The request was rejected. Check permissions, unavailable metrics and the current preview. A changed or cancelled review cannot be approved."
      );
    } finally {
      setBusy(false);
    }
  }
  function addRule() {
    const lower = minimum === "" ? null : Number(minimum),
      upper = maximum === "" ? null : Number(maximum);
    if (
      (lower === null && upper === null) ||
      (lower !== null && (!Number.isFinite(lower) || lower < 0)) ||
      (upper !== null && (!Number.isFinite(upper) || upper < 0)) ||
      (lower !== null && upper !== null && lower > upper)
    ) {
      setError("Enter a valid minimum or maximum.");
      return;
    }
    const sampleKey = sample || null;
    if (
      selection.thresholds.some((rule) => rule.metric === metric && rule.sampleKey === sampleKey)
    ) {
      setError("Remove the existing rule for this metric and sample before replacing it.");
      return;
    }
    setError("");
    setSelection({
      ...selection,
      thresholds: [...selection.thresholds, { metric, minimum: lower, maximum: upper, sampleKey }],
    });
    setMinimum("");
    setMaximum("");
  }
  async function download() {
    if (!view?.filteredArtifactId) return;
    try {
      const data = await qcRequest(
        path + "/artifact?artifactId=" + encodeURIComponent(view.filteredArtifactId)
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("downloadUrl" in data) ||
        typeof data.downloadUrl !== "string" ||
        new URL(data.downloadUrl).protocol !== "https:"
      )
        throw new Error();
      window.location.assign(data.downloadUrl);
    } catch {
      setError("The filtered artifact could not be downloaded.");
    }
  }
  if (!view)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">QC review</h1>
        <p role="status">Loading authorized QC review…</p>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const reviewable =
    view.status === "QC_REVIEW_REQUIRED" && view.canApprove && view.decision === null;
  const summary = view.summary;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">QC review and cell filtering</h1>
          <p className="text-sm text-muted-foreground">
            Raw canonical counts remain unchanged. No downstream analysis runs in this pipeline.
          </p>
        </div>
        <Badge>{view.status.replaceAll("_", " ")}</Badge>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!summary && (
        <p role="status">QC metrics are being prepared. You can leave and return to this page.</p>
      )}
      {summary && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Quality overview</CardTitle>
              <CardDescription>
                {summary.cellCount.toLocaleString()} cells · {summary.geneCount.toLocaleString()}{" "}
                genes. Thresholds are explicit review choices, not universal biological cutoffs.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {summary.issues.length > 0 && (
                <section aria-label="Scientific issues">
                  <h2 className="font-medium">Scientific warnings and unavailable assessments</h2>
                  <ul className="list-disc pl-5">
                    {summary.issues.map((issue, i) => (
                      <li key={i}>
                        {issue.code.replaceAll("_", " ").toLowerCase()} —{" "}
                        {issue.affectedCells.toLocaleString()} cells
                        {issue.groupKey ? " / " + issue.groupKey : ""}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {summary.metrics.map((value) => (
                  <QcHistogram key={value.metric} metric={value} />
                ))}
              </div>
            </CardContent>
            <CardFooter>
              <p className="text-sm text-muted-foreground">
                No numeric threshold suggestions are supplied unless a validated suggestion policy
                exists.
              </p>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Registered-sample QC</CardTitle>
              <CardDescription>
                {summary.sampleQcAvailable
                  ? "Summaries use explicit registered sample assignments."
                  : "Sample-level QC is unavailable for some or all cells; no sample identities were inferred."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {summary.samples.slice(samplePage * 20, samplePage * 20 + 20).map((value) => (
                <details key={value.sampleId}>
                  <summary className="cursor-pointer">
                    {value.sampleKey} — {value.cellCount.toLocaleString()} cells
                  </summary>
                  <dl className="grid gap-2 py-3 sm:grid-cols-2">
                    {value.metrics.map((entry) => (
                      <div key={entry.metric}>
                        <dt>{labels[entry.metric]}</dt>
                        <dd>
                          Mean {display(entry.mean)}; range {display(entry.minimum)}–
                          {display(entry.maximum)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
              {summary.samples.length === 0 && <p>No registered-sample summaries are available.</p>}
            </CardContent>
            <CardFooter className="gap-3">
              <Button
                variant="outline"
                disabled={samplePage === 0}
                onClick={() => setSamplePage(samplePage - 1)}
              >
                Previous samples
              </Button>
              <Button
                variant="outline"
                disabled={(samplePage + 1) * 20 >= summary.samples.length}
                onClick={() => setSamplePage(samplePage + 1)}
              >
                Next samples
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Doublet assessment</CardTitle>
              <CardDescription>
                Predictions are review information. They do not remove cells.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {summary.doublets.length === 0 && (
                <p>Not assessed: capture/library grouping is unresolved.</p>
              )}
              {summary.doublets.map((group) => (
                <div key={group.captureGroupKey}>
                  <h3 className="font-medium">{group.captureGroupKey}</h3>
                  <p>
                    {group.status === "ASSESSED" ? "Assessed" : "Not assessed"} · predicted cells:{" "}
                    {display(group.predictedCount)} · threshold: {display(group.threshold)}
                  </p>
                  {group.reason && <p>{group.reason.replaceAll("_", " ").toLowerCase()}</p>}
                </div>
              ))}
            </CardContent>
            <CardFooter>
              <details>
                <summary className="cursor-pointer">Algorithm provenance</summary>
                <p>
                  {summary.scrubletProfile}; seed {summary.randomSeed}; gene policy{" "}
                  {summary.geneSetPolicy}
                </p>
                <ul>
                  {summary.software.map((value) => (
                    <li key={value.name}>
                      {value.name}: {value.version}
                    </li>
                  ))}
                </ul>
                {summary.doublets.map((group) => (
                  <details key={group.captureGroupKey}>
                    <summary>{group.captureGroupKey} effective parameters</summary>
                    <dl>
                      {group.parameters.map((parameter) => (
                        <div key={parameter.name}>
                          <dt>{parameter.name}</dt>
                          <dd>{parameter.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ))}
              </details>
            </CardFooter>
          </Card>
        </>
      )}
      {reviewable && (
        <Card>
          <CardHeader>
            <CardTitle>Propose cell selection</CardTitle>
            <CardDescription>
              Empty settings retain all cells. Sample-specific rules replace global rules for that
              metric. A trusted preview must be calculated before confirmation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <fieldset className="flex flex-col gap-3">
              <legend className="font-medium">Threshold rule</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  Metric
                  <select
                    className={control}
                    value={metric}
                    onChange={(event) => {
                      const found = summary?.metrics.find(
                        (value) => value.metric === event.target.value
                      );
                      if (found) setMetric(found.metric);
                    }}
                  >
                    {summary?.metrics.map((value) => (
                      <option key={value.metric} value={value.metric}>
                        {labels[value.metric]}
                        {value.availableCells === 0 ? " (unavailable)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Scope
                  <select
                    className={control}
                    value={sample}
                    onChange={(event) => setSample(event.target.value)}
                  >
                    <option value="">All cells</option>
                    {summary?.samples.map((value) => (
                      <option key={value.sampleId} value={value.sampleKey}>
                        {value.sampleKey}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Minimum (inclusive)
                  <input
                    className={control}
                    type="number"
                    min="0"
                    step="any"
                    value={minimum}
                    onChange={(event) => setMinimum(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  Maximum (inclusive)
                  <input
                    className={control}
                    type="number"
                    min="0"
                    step="any"
                    value={maximum}
                    onChange={(event) => setMaximum(event.target.value)}
                  />
                </label>
              </div>
              <Button variant="outline" type="button" onClick={addRule}>
                Add threshold rule
              </Button>
            </fieldset>
            <ul className="flex flex-col gap-2">
              {selection.thresholds.map((rule, i) => (
                <li key={i} className="flex flex-wrap items-center gap-3">
                  <span>
                    {labels[rule.metric]} / {rule.sampleKey ?? "all cells"}:{" "}
                    {rule.minimum ?? "no minimum"} to {rule.maximum ?? "no maximum"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={"Remove " + labels[rule.metric] + " rule"}
                    onClick={() =>
                      setSelection({
                        ...selection,
                        thresholds: selection.thresholds.filter((_, index) => index !== i),
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <label className="flex flex-col gap-1">
              Doublet handling
              <select
                className={control}
                value={selection.doubletHandling}
                onChange={(event) =>
                  setSelection({
                    ...selection,
                    doubletHandling:
                      event.target.value === "EXCLUDE_PREDICTED" ? "EXCLUDE_PREDICTED" : "RETAIN",
                  })
                }
              >
                <option value="RETAIN">Retain cells regardless of predicted doublets</option>
                <option value="EXCLUDE_PREDICTED">
                  Exclude predicted doublets (requires complete assessment)
                </option>
              </select>
            </label>
            {view.previewError && (
              <p role="alert">
                The preview could not be assessed. Check unavailable metrics, doublet assessment and
                whether the selection would retain any cells.
              </p>
            )}
            {view.previewPending && (
              <p role="status">Trusted selection preview is being calculated.</p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              size="lg"
              disabled={busy || view.previewPending}
              onClick={() => void action("preview", selection)}
            >
              Calculate trusted preview
            </Button>
          </CardFooter>
        </Card>
      )}
      {reviewable && view.preview && (
        <Card>
          <CardHeader>
            <CardTitle>Confirm the exact preview</CardTitle>
            <CardDescription>
              Included: {view.preview.includedCount.toLocaleString()} · Excluded:{" "}
              {view.preview.excludedCount.toLocaleString()}. These counts were calculated by
              science.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!sameQcSelection(selection, view.previewParameters) && (
              <p role="alert">Settings changed. Calculate a new preview before approving.</p>
            )}
            <label className="flex flex-col gap-2">
              Reason for this decision
              <textarea
                className={control}
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">
                Research use only. Do not include PHI.
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-5"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed this selection and approve creating an immutable filtered output.
            </label>
          </CardContent>
          <CardFooter>
            <Button
              size="lg"
              disabled={busy || !confirmed || !reason.trim() || !canConfirmQc(view, selection)}
              onClick={() => void action("approve", { previewId: view.preview?.previewId, reason })}
            >
              Approve selection and filter
            </Button>
          </CardFooter>
        </Card>
      )}
      {view.decision && (
        <section aria-label="Recorded decision">
          <h2 className="font-medium">Immutable decision recorded</h2>
          <p>{view.decision.reason}</p>
          <p className="text-sm">
            Recorded {view.decision.createdAt}. Included {view.decision.preview.includedCount};
            excluded {view.decision.preview.excludedCount}.
          </p>
        </section>
      )}
      {!view.canApprove && <p>You have read-only access to this review.</p>}
      {view.status === "SUCCEEDED" && (
        <section>
          <h2 className="font-medium">QC and confirmed filtering complete</h2>
          <p>Downstream analysis has not been run.</p>
          <Button disabled={!view.filteredArtifactId} onClick={() => void download()}>
            Download filtered dataset
          </Button>
        </section>
      )}
      {view.canApprove && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(view.status) && (
        <Button
          variant="destructive"
          className="self-start"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Cancel this QC/filter run? Canonical input will remain unchanged."))
              void action("cancel", {});
          }}
        >
          Cancel QC run
        </Button>
      )}
    </div>
  );
}
