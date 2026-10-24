"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { QcInputOptions } from "@cellweave/contracts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { isQcInputOptions, qcRequest } from "@/lib/qc-client-validation";
const control =
  "min-h-11 rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function QcStart() {
  const router = useRouter();
  const [options, setOptions] = useState<QcInputOptions | null>(null);
  const [version, setVersion] = useState("");
  const [whole, setWhole] = useState("");
  const [captures, setCaptures] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    void qcRequest("/api/v1/qc")
      .then((value) => {
        if (!isQcInputOptions(value)) throw new Error("Invalid QC inputs");
        if (active) setOptions(value);
      })
      .catch(() => {
        if (active)
          setError(
            "QC inputs could not be loaded. Check your active organization and project access."
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const dataset = options?.datasets.find((value) => value.datasetVersionId === version);
  const bindings = Object.entries(captures)
    .filter(([, key]) => key !== "")
    .map(([sampleId, captureGroupKey]) => ({ sampleId, captureGroupKey }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dataset || !options?.canStart || (bindings.length > 0 && !confirmed)) return;
    setBusy(true);
    setError("");
    try {
      const body = JSON.stringify({
        datasetVersionId: version,
        wholeInputSampleId: whole || null,
        captureBindings: bindings,
      });
      if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
      const result = await qcRequest("/api/v1/qc", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": request.current.key },
        body,
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("analysisRunId" in result) ||
        typeof result.analysisRunId !== "string"
      )
        throw new Error();
      router.push("/analyses/qc/" + encodeURIComponent(result.analysisRunId));
    } catch {
      setError(
        "QC could not be started. The input must be finalized and accessible, and mappings must reference registered samples."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Start quality control</CardTitle>
        <CardDescription>
          Inspect raw-count quality before choosing which cells to retain. This pipeline stops after
          confirmed filtering.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form id="qc-start" onSubmit={submit} className="flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            Finalized dataset version
            <select
              className={control}
              required
              value={version}
              onChange={(event) => {
                setVersion(event.target.value);
                setWhole("");
                setCaptures({});
                setConfirmed(false);
              }}
            >
              <option value="">Choose a dataset</option>
              {options?.datasets.map((value) => (
                <option key={value.datasetVersionId} value={value.datasetVersionId}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          {dataset && (
            <>
              <label className="flex flex-col gap-2">
                Whole-input sample assignment
                <select
                  className={control}
                  value={whole}
                  onChange={(event) => setWhole(event.target.value)}
                >
                  <option value="">Use existing canonical assignments, if available</option>
                  {dataset.samples.map((sample) => (
                    <option key={sample.sampleId} value={sample.sampleId}>
                      {sample.label} ({sample.sampleKey})
                    </option>
                  ))}
                </select>
                <span className="text-sm text-muted-foreground">
                  Select a registered sample only if the entire input belongs to it. Missing
                  assignments remain unavailable.
                </span>
              </label>
              <fieldset className="flex flex-col gap-3">
                <legend className="font-medium">Capture/library grouping (optional)</legend>
                <p className="text-sm text-muted-foreground">
                  A biological sample is not automatically a capture library. Leave unknown groups
                  blank; doublets will remain not assessed.
                </p>
                {dataset.samples.map((sample) => (
                  <label key={sample.sampleId} className="flex flex-col gap-1">
                    {sample.label} ({sample.sampleKey})
                    <input
                      className={control}
                      maxLength={200}
                      value={captures[sample.sampleId] ?? ""}
                      onChange={(event) => {
                        setCaptures({ ...captures, [sample.sampleId]: event.target.value });
                        setConfirmed(false);
                      }}
                      placeholder="Known capture/library key"
                    />
                  </label>
                ))}
                {bindings.length > 0 && (
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      required
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      className="mt-1 size-5"
                    />
                    I confirm these mappings describe the actual capture/library units.
                  </label>
                )}
              </fieldset>
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {options && !options.canStart && (
            <p>You have read-only access. An authorized scientist must start QC.</p>
          )}
          {options?.datasets.length === 0 && (
            <p>No accessible finalized dataset versions are available.</p>
          )}
        </form>
      </CardContent>
      <CardFooter>
        <Button
          size="lg"
          form="qc-start"
          type="submit"
          disabled={busy || !dataset || !options?.canStart || (bindings.length > 0 && !confirmed)}
        >
          {busy ? "Starting QC…" : "Compute QC"}
        </Button>
      </CardFooter>
    </Card>
  );
}
