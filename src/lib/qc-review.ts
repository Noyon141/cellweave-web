import type { QcReviewView, QcSelectionParameters } from "@cellweave/contracts";
export function sameQcSelection(
  a: QcSelectionParameters,
  b: QcSelectionParameters | null
): boolean {
  return (
    b !== null &&
    a.doubletHandling === b.doubletHandling &&
    a.thresholds.length === b.thresholds.length &&
    a.thresholds.every((rule, i) => {
      const other = b.thresholds[i];
      return (
        other !== undefined &&
        rule.metric === other.metric &&
        rule.minimum === other.minimum &&
        rule.maximum === other.maximum &&
        rule.sampleKey === other.sampleKey
      );
    })
  );
}
export function canConfirmQc(view: QcReviewView, selection: QcSelectionParameters): boolean {
  return (
    view.canApprove &&
    view.status === "QC_REVIEW_REQUIRED" &&
    view.decision === null &&
    view.preview !== null &&
    !view.previewPending &&
    view.previewError === null &&
    sameQcSelection(selection, view.previewParameters)
  );
}
