import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { TenantContext } from "@/types";
import {
  UnauthenticatedError,
  TenantAuthorizationError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
  IntegrityError,
} from "@/server/authorization/errors";
import { StorageError } from "@/server/integrations/storage/storage-types";
import { handleRouteError } from "@/server/api/error-handler";

// Route handlers under test
import * as ProjectsRoute from "@/app/api/v1/projects/route";
import * as ProjectDetailRoute from "@/app/api/v1/projects/[projectId]/route";
import * as ProjectExperimentsRoute from "@/app/api/v1/projects/[projectId]/experiments/route";
import * as ExperimentDetailRoute from "@/app/api/v1/experiments/[experimentId]/route";
import * as ExperimentSamplesRoute from "@/app/api/v1/experiments/[experimentId]/samples/route";
import * as SampleDetailRoute from "@/app/api/v1/samples/[sampleId]/route";
import * as ProjectDatasetsRoute from "@/app/api/v1/projects/[projectId]/datasets/route";
import * as DatasetDetailRoute from "@/app/api/v1/datasets/[datasetId]/route";
import * as DatasetVersionsRoute from "@/app/api/v1/datasets/[datasetId]/versions/route";
import * as DatasetVersionDetailRoute from "@/app/api/v1/dataset-versions/[datasetVersionId]/route";
import * as InitiateUploadRoute from "@/app/api/v1/dataset-versions/[datasetVersionId]/uploads/route";
import * as UploadDetailRoute from "@/app/api/v1/uploads/[uploadSessionId]/route";
import * as UploadResumeRoute from "@/app/api/v1/uploads/[uploadSessionId]/resume/route";
import * as UploadPartsRoute from "@/app/api/v1/uploads/[uploadSessionId]/parts/route";
import * as UploadCompleteRoute from "@/app/api/v1/uploads/[uploadSessionId]/complete/route";
import * as UploadAbortRoute from "@/app/api/v1/uploads/[uploadSessionId]/abort/route";

// Mock authorization
const mockTenantContext: TenantContext = Object.freeze({
  organizationId: "org_test_12345",
  userId: "usr_test_67890",
  role: "admin",
});

let resolveTenantContextMock = vi.fn().mockResolvedValue(mockTenantContext);

vi.mock("@/server/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/authorization")>();
  return {
    ...actual,
    resolveTenantContext: (...args: unknown[]) => resolveTenantContextMock(...args),
  };
});

// Mock services
const mockProject = {
  id: "prj_019488a0b0c170008000000000000001",
  organizationId: "org_test_12345",
  name: "Target Project",
  description: "Test description",
  status: "active",
  createdBy: "usr_test_67890",
  createdAt: new Date(),
  updatedAt: new Date(),
  archivedAt: null,
};

const mockExperiment = {
  id: "exp_019488a0b0c170008000000000000002",
  organizationId: "org_test_12345",
  projectId: "prj_019488a0b0c170008000000000000001",
  name: "Target Experiment",
  description: "Test experiment",
  organism: "Homo sapiens",
  tissue: "PBMC",
  diseaseContext: "Healthy",
  createdBy: "usr_test_67890",
  createdAt: new Date(),
};

const mockSample = {
  id: "smp_019488a0b0c170008000000000000003",
  organizationId: "org_test_12345",
  experimentId: "exp_019488a0b0c170008000000000000002",
  sampleKey: "SAMPLE_001",
  displayName: "Sample 1",
  condition: "Control",
  batch: "BatchA",
  biologicalReplicate: "1",
  technicalReplicate: "1",
  metadataJson: {},
};

const mockDataset = {
  id: "ds_019488a0b0c170008000000000000004",
  organizationId: "org_test_12345",
  projectId: "prj_019488a0b0c170008000000000000001",
  name: "Target Dataset",
  description: "Test dataset",
  status: "active",
  createdBy: "usr_test_67890",
  createdAt: new Date(),
};

const mockDatasetVersion = {
  id: "dsv_019488a0b0c170008000000000000005",
  organizationId: "org_test_12345",
  datasetId: "ds_019488a0b0c170008000000000000004",
  versionNumber: 1,
  sourceFormat: "h5ad",
  canonicalFormat: null,
  organism: "Homo sapiens",
  geneIdScheme: "Ensembl",
  referenceBuild: "GRCh38",
  cellCount: 5000,
  geneCount: 20000,
  sourceChecksum: null,
  canonicalChecksum: null,
  createdAt: new Date(),
};

const mockUploadSession = {
  id: "ups_019488a0b0c170008000000000000006",
  organizationId: "org_test_12345",
  projectId: "prj_019488a0b0c170008000000000000001",
  datasetVersionId: "dsv_019488a0b0c170008000000000000005",
  r2Key: "org/prj/ds/file.h5ad",
  r2UploadId: "SENSITIVE_R2_UPLOAD_ID_DO_NOT_LEAK",
  status: "CREATED" as const,
  expectedSize: 10485760,
  partSize: 5242880,
  totalParts: 2,
  expiresAt: new Date(Date.now() + 86400000),
  failureCode: null,
  failureSummary: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDatasetFile = {
  id: "dsf_019488a0b0c170008000000000000007",
  organizationId: "org_test_12345",
  datasetVersionId: "dsv_019488a0b0c170008000000000000005",
  r2Key: "org/prj/ds/file.h5ad",
  byteSize: 10485760,
  fileName: "file.h5ad",
  contentType: "application/x-hdf5",
  eTag: '"computed-etag-12345"',
  createdAt: new Date(),
};

vi.mock("@/server/services/project-service", () => {
  return {
    createProjectSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { name?: string };
        if (!body.name || body.name.trim() === "") {
          throw new ValidationError("Project name is required");
        }
        return body;
      }),
    },
    updateProjectSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { name?: string; description?: string };
        if (body.name === undefined && body.description === undefined) {
          throw new ValidationError("At least one field must be provided for update");
        }
        return body;
      }),
    },
    ProjectService: vi.fn().mockImplementation(() => ({
      createProject: vi.fn().mockResolvedValue(mockProject),
      getProject: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockProject.id) return Promise.resolve(mockProject);
        throw new ResourceNotFoundError("Project not found");
      }),
      listAccessibleProjects: vi.fn().mockResolvedValue([mockProject]),
      updateProject: vi.fn().mockResolvedValue({ ...mockProject, name: "Updated Name" }),
      archiveProject: vi
        .fn()
        .mockResolvedValue({ ...mockProject, status: "archived", archivedAt: new Date() }),
    })),
  };
});

vi.mock("@/server/services/experiment-service", () => {
  return {
    createExperimentSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { name?: string };
        if (!body.name || body.name.trim() === "") {
          throw new ValidationError("Experiment name is required");
        }
        return body;
      }),
    },
    updateExperimentSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { name?: string };
        if (!body || Object.keys(body).length === 0) {
          throw new ValidationError("At least one field must be provided for update");
        }
        return body;
      }),
    },
    ExperimentService: vi.fn().mockImplementation(() => ({
      createExperiment: vi.fn().mockResolvedValue(mockExperiment),
      getExperiment: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockExperiment.id) return Promise.resolve(mockExperiment);
        throw new ResourceNotFoundError("Experiment not found");
      }),
      listProjectExperiments: vi.fn().mockResolvedValue([mockExperiment]),
      updateExperiment: vi.fn().mockResolvedValue({ ...mockExperiment, name: "Updated Exp" }),
    })),
  };
});

vi.mock("@/server/services/sample-service", () => {
  return {
    createSampleSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { sampleKey?: string };
        if (!body.sampleKey || body.sampleKey.trim() === "") {
          throw new ValidationError("Sample key is required");
        }
        if (body.sampleKey === "DUPLICATE") {
          throw new ConflictError("Sample key already exists in this experiment");
        }
        return body;
      }),
    },
    updateSampleSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { displayName?: string };
        if (!body || Object.keys(body).length === 0) {
          throw new ValidationError("At least one field must be provided for update");
        }
        return body;
      }),
    },
    SampleService: vi.fn().mockImplementation(() => ({
      createSample: vi.fn().mockImplementation((_ctx, _expId, input) => {
        if (input.sampleKey === "DUPLICATE") {
          throw new ConflictError("Sample key already exists in this experiment");
        }
        return Promise.resolve(mockSample);
      }),
      getSample: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockSample.id) return Promise.resolve(mockSample);
        throw new ResourceNotFoundError("Sample not found");
      }),
      listExperimentSamples: vi.fn().mockResolvedValue([mockSample]),
      updateSample: vi.fn().mockResolvedValue({ ...mockSample, displayName: "Updated Sample" }),
    })),
  };
});

vi.mock("@/server/services/dataset-service", () => {
  return {
    createDatasetSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { name?: string };
        if (!body.name || body.name.trim() === "") {
          throw new ValidationError("Dataset name is required");
        }
        return body;
      }),
    },
    createDatasetVersionSchema: {
      parse: vi.fn((input: unknown) => {
        const body = input as { sourceFormat?: string };
        if (!body.sourceFormat || body.sourceFormat.trim() === "") {
          throw new ValidationError("Source format is required");
        }
        return body;
      }),
    },
    DatasetService: vi.fn().mockImplementation(() => ({
      createDataset: vi.fn().mockResolvedValue(mockDataset),
      getDataset: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockDataset.id) return Promise.resolve(mockDataset);
        throw new ResourceNotFoundError("Dataset not found");
      }),
      listProjectDatasets: vi.fn().mockResolvedValue([mockDataset]),
      createDatasetVersion: vi.fn().mockResolvedValue(mockDatasetVersion),
      listDatasetVersions: vi.fn().mockResolvedValue([mockDatasetVersion]),
      getDatasetVersion: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockDatasetVersion.id) return Promise.resolve(mockDatasetVersion);
        throw new ResourceNotFoundError("Dataset version not found");
      }),
    })),
  };
});

vi.mock("@/server/services/upload-session-service", () => {
  return {
    UploadSessionService: vi.fn().mockImplementation(() => ({
      initiateUpload: vi.fn().mockImplementation((_ctx, input) => {
        if (!input.fileName || input.fileName.trim() === "") {
          throw new ValidationError("fileName is required");
        }
        return Promise.resolve(mockUploadSession);
      }),
      getUploadSession: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockUploadSession.id) return Promise.resolve(mockUploadSession);
        throw new ResourceNotFoundError("Upload session not found");
      }),
      getResumeState: vi.fn().mockImplementation((_ctx, id) => {
        if (id === mockUploadSession.id) {
          return Promise.resolve({
            sessionId: id,
            status: "UPLOADING",
            totalParts: 2,
            partSize: 5242880,
            expectedSize: 10485760,
            uploadedParts: [{ partNumber: 1, eTag: '"part1etag"', sizeBytes: 5242880 }],
            missingParts: [2],
          });
        }
        throw new ResourceNotFoundError("Upload session not found");
      }),
      createPartUploadUrls: vi.fn().mockImplementation((_ctx, input) => {
        return Promise.resolve(
          input.partNumbers.map((partNumber: number) => ({
            partNumber,
            presignedUrl: `https://mock-r2.cloudflarestorage.com/bucket/key?partNumber=${partNumber}&uploadId=mock`,
            expiresInSeconds: 900,
          }))
        );
      }),
      completeUpload: vi.fn().mockImplementation((_ctx, id) => {
        if (id === "ups_integrity_error") {
          throw new IntegrityError("Verified byte count does not match expected size");
        }
        if (id === "ups_storage_retryable") {
          throw new StorageError("Network blip", "PROVIDER_ERROR", true);
        }
        if (id === "ups_storage_not_found") {
          throw new StorageError("Upload not found", "MULTIPART_UPLOAD_NOT_FOUND", false);
        }
        if (id === mockUploadSession.id) {
          return Promise.resolve({
            session: { ...mockUploadSession, status: "VERIFIED" as const },
            file: mockDatasetFile,
          });
        }
        throw new ResourceNotFoundError("Upload session not found");
      }),
      abortUpload: vi.fn().mockImplementation((_ctx, id) => {
        if (id === "ups_conflict_abort") {
          throw new ConflictError("Cannot abort an already VERIFIED upload session");
        }
        if (id === mockUploadSession.id) {
          return Promise.resolve({ ...mockUploadSession, status: "ABORTED" as const });
        }
        throw new ResourceNotFoundError("Upload session not found");
      }),
    })),
  };
});

describe("Phase 2 Step H — Thin Route Handlers Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTenantContextMock.mockResolvedValue(mockTenantContext);
  });

  describe("1. Authentication & Non-Disclosing Authorization Rejection", () => {
    it("returns 401 UNAUTHENTICATED when unauthenticated", async () => {
      resolveTenantContextMock.mockRejectedValueOnce(
        new UnauthenticatedError("Authentication required")
      );

      const req = new NextRequest("http://localhost/api/v1/projects");
      const res = await ProjectsRoute.GET(req);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({
        error: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    });

    it("returns 403 FORBIDDEN on tenant authorization failure without leaking IDs", async () => {
      resolveTenantContextMock.mockRejectedValueOnce(
        new TenantAuthorizationError("Cross-tenant access forbidden")
      );

      const req = new NextRequest("http://localhost/api/v1/projects");
      const res = await ProjectsRoute.GET(req);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({
        error: "FORBIDDEN",
        message: "You are not authorized to access this resource.",
      });
    });
  });

  describe("2. Projects Route Handlers", () => {
    it("GET /api/v1/projects lists projects respecting includeArchived query", async () => {
      const req = new NextRequest("http://localhost/api/v1/projects?includeArchived=true");
      const res = await ProjectsRoute.GET(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(mockProject.id);
    });

    it("POST /api/v1/projects creates a project and returns 201", async () => {
      const req = new NextRequest("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Target Project", description: "Test description" }),
      });
      const res = await ProjectsRoute.POST(req);

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockProject.id);
    });

    it("POST /api/v1/projects rejects invalid input with 400", async () => {
      const req = new NextRequest("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });
      const res = await ProjectsRoute.POST(req);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("BAD_REQUEST");
    });

    it("GET /api/v1/projects/[projectId] returns 200 for existing project", async () => {
      const req = new NextRequest(`http://localhost/api/v1/projects/${mockProject.id}`);
      const res = await ProjectDetailRoute.GET(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockProject.id);
    });

    it("GET /api/v1/projects/[projectId] returns 404 for unknown project", async () => {
      const req = new NextRequest("http://localhost/api/v1/projects/prj_unknown");
      const res = await ProjectDetailRoute.GET(req, {
        params: Promise.resolve({ projectId: "prj_unknown" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toEqual({ error: "NOT_FOUND", message: "Resource not found" });
    });

    it("PATCH /api/v1/projects/[projectId] updates metadata", async () => {
      const req = new NextRequest(`http://localhost/api/v1/projects/${mockProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      });
      const res = await ProjectDetailRoute.PATCH(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.name).toBe("Updated Name");
    });

    it("DELETE /api/v1/projects/[projectId] archives the project", async () => {
      const req = new NextRequest(`http://localhost/api/v1/projects/${mockProject.id}`, {
        method: "DELETE",
      });
      const res = await ProjectDetailRoute.DELETE(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("archived");
      expect(json.data.archivedAt).toBeDefined();
    });
  });

  describe("3. Experiments & Samples Route Handlers", () => {
    it("POST /api/v1/projects/[projectId]/experiments creates experiment with 201", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/projects/${mockProject.id}/experiments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Target Experiment", organism: "Homo sapiens" }),
        }
      );
      const res = await ProjectExperimentsRoute.POST(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockExperiment.id);
    });

    it("GET /api/v1/projects/[projectId]/experiments lists experiments", async () => {
      const req = new NextRequest(`http://localhost/api/v1/projects/${mockProject.id}/experiments`);
      const res = await ProjectExperimentsRoute.GET(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
    });

    it("GET /api/v1/experiments/[experimentId] returns experiment details", async () => {
      const req = new NextRequest(`http://localhost/api/v1/experiments/${mockExperiment.id}`);
      const res = await ExperimentDetailRoute.GET(req, {
        params: Promise.resolve({ experimentId: mockExperiment.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockExperiment.id);
    });

    it("POST /api/v1/experiments/[experimentId]/samples creates sample with 201", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/experiments/${mockExperiment.id}/samples`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sampleKey: "SAMPLE_001", displayName: "Sample 1" }),
        }
      );
      const res = await ExperimentSamplesRoute.POST(req, {
        params: Promise.resolve({ experimentId: mockExperiment.id }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockSample.id);
    });

    it("POST /api/v1/experiments/[experimentId]/samples maps ConflictError to 409", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/experiments/${mockExperiment.id}/samples`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sampleKey: "DUPLICATE" }),
        }
      );
      const res = await ExperimentSamplesRoute.POST(req, {
        params: Promise.resolve({ experimentId: mockExperiment.id }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("CONFLICT");
    });

    it("GET /api/v1/samples/[sampleId] returns sample details", async () => {
      const req = new NextRequest(`http://localhost/api/v1/samples/${mockSample.id}`);
      const res = await SampleDetailRoute.GET(req, {
        params: Promise.resolve({ sampleId: mockSample.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockSample.id);
    });
  });

  describe("4. Datasets & Dataset Versions Route Handlers", () => {
    it("POST /api/v1/projects/[projectId]/datasets creates dataset with 201", async () => {
      const req = new NextRequest(`http://localhost/api/v1/projects/${mockProject.id}/datasets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Target Dataset" }),
      });
      const res = await ProjectDatasetsRoute.POST(req, {
        params: Promise.resolve({ projectId: mockProject.id }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockDataset.id);
    });

    it("GET /api/v1/datasets/[datasetId] returns dataset details", async () => {
      const req = new NextRequest(`http://localhost/api/v1/datasets/${mockDataset.id}`);
      const res = await DatasetDetailRoute.GET(req, {
        params: Promise.resolve({ datasetId: mockDataset.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockDataset.id);
    });

    it("POST /api/v1/datasets/[datasetId]/versions creates immutable version with 201", async () => {
      const req = new NextRequest(`http://localhost/api/v1/datasets/${mockDataset.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFormat: "h5ad", cellCount: 5000 }),
      });
      const res = await DatasetVersionsRoute.POST(req, {
        params: Promise.resolve({ datasetId: mockDataset.id }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockDatasetVersion.id);
      expect(json.data.versionNumber).toBe(1);
    });

    it("GET /api/v1/dataset-versions/[datasetVersionId] returns immutable version details", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/dataset-versions/${mockDatasetVersion.id}`
      );
      const res = await DatasetVersionDetailRoute.GET(req, {
        params: Promise.resolve({ datasetVersionId: mockDatasetVersion.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockDatasetVersion.id);
    });
  });

  describe("5. Upload Session Orchestration Routes", () => {
    it("POST /api/v1/dataset-versions/[datasetVersionId]/uploads binds route param and omits r2UploadId", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/dataset-versions/${mockDatasetVersion.id}/uploads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Attacker attempts authority injection with different datasetVersionId
            datasetVersionId: "dsv_spoofed_other_org",
            fileName: "matrix.h5ad",
            contentType: "application/x-hdf5",
            expectedSize: 10485760,
          }),
        }
      );
      const res = await InitiateUploadRoute.POST(req, {
        params: Promise.resolve({ datasetVersionId: mockDatasetVersion.id }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe(mockUploadSession.id);
      // STRICT INVARIANT: r2UploadId must NEVER be returned in response DTO
      expect(json.data.r2UploadId).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("SENSITIVE_R2_UPLOAD_ID_DO_NOT_LEAK");
    });

    it("POST /api/v1/dataset-versions/[datasetVersionId]/uploads validates input parameters", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/dataset-versions/${mockDatasetVersion.id}/uploads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: "matrix.h5ad",
            contentType: "application/x-hdf5",
            expectedSize: -50, // invalid expectedSize
          }),
        }
      );
      const res = await InitiateUploadRoute.POST(req, {
        params: Promise.resolve({ datasetVersionId: mockDatasetVersion.id }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("BAD_REQUEST");
    });

    it("GET /api/v1/uploads/[uploadSessionId] returns session status without r2UploadId", async () => {
      const req = new NextRequest(`http://localhost/api/v1/uploads/${mockUploadSession.id}`);
      const res = await UploadDetailRoute.GET(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe(mockUploadSession.id);
      expect(json.data.r2UploadId).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("SENSITIVE_R2_UPLOAD_ID_DO_NOT_LEAK");
    });

    it("GET /api/v1/uploads/[uploadSessionId]/resume returns resume state", async () => {
      const req = new NextRequest(`http://localhost/api/v1/uploads/${mockUploadSession.id}/resume`);
      const res = await UploadResumeRoute.GET(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.sessionId).toBe(mockUploadSession.id);
      expect(json.data.uploadedParts).toHaveLength(1);
      expect(json.data.missingParts).toEqual([2]);
    });

    it("POST /api/v1/uploads/[uploadSessionId]/parts returns presigned URLs with Cache-Control: no-store, private", async () => {
      const req = new NextRequest(`http://localhost/api/v1/uploads/${mockUploadSession.id}/parts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers: [1, 2] }),
      });
      const res = await UploadPartsRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store, private");

      const json = await res.json();
      expect(json.data).toHaveLength(2);
      expect(json.data[0].partNumber).toBe(1);
      expect(json.data[0].presignedUrl).toContain("partNumber=1");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/parts rejects empty or invalid part numbers", async () => {
      const req = new NextRequest(`http://localhost/api/v1/uploads/${mockUploadSession.id}/parts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers: [] }),
      });
      const res = await UploadPartsRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("BAD_REQUEST");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/complete successfully completes and returns safe DTO", async () => {
      const req = new NextRequest(
        `http://localhost/api/v1/uploads/${mockUploadSession.id}/complete`,
        {
          method: "POST",
        }
      );
      const res = await UploadCompleteRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.session.status).toBe("VERIFIED");
      expect(json.data.file.id).toBe(mockDatasetFile.id);
      expect(json.data.session.r2UploadId).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("SENSITIVE_R2_UPLOAD_ID_DO_NOT_LEAK");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/complete maps IntegrityError to 409", async () => {
      const req = new NextRequest("http://localhost/api/v1/uploads/ups_integrity_error/complete", {
        method: "POST",
      });
      const res = await UploadCompleteRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: "ups_integrity_error" }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("CONFLICT");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/complete maps retryable StorageError to 503", async () => {
      const req = new NextRequest(
        "http://localhost/api/v1/uploads/ups_storage_retryable/complete",
        {
          method: "POST",
        }
      );
      const res = await UploadCompleteRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: "ups_storage_retryable" }),
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe("SERVICE_UNAVAILABLE");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/abort cancels session and returns safe DTO", async () => {
      const req = new NextRequest(`http://localhost/api/v1/uploads/${mockUploadSession.id}/abort`, {
        method: "POST",
      });
      const res = await UploadAbortRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: mockUploadSession.id }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("ABORTED");
      expect(json.data.r2UploadId).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("SENSITIVE_R2_UPLOAD_ID_DO_NOT_LEAK");
    });

    it("POST /api/v1/uploads/[uploadSessionId]/abort returns 409 if session is already completed", async () => {
      const req = new NextRequest("http://localhost/api/v1/uploads/ups_conflict_abort/abort", {
        method: "POST",
      });
      const res = await UploadAbortRoute.POST(req, {
        params: Promise.resolve({ uploadSessionId: "ups_conflict_abort" }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("CONFLICT");
    });
  });

  describe("6. Error Non-Disclosure & Credential Leakage Protection", () => {
    it("never exposes internal database connection string or AWS credentials on unexpected error", async () => {
      const fakeSensitiveError = new Error(
        "Connection failed: postgresql://admin:super_secret_db_password@ep-cool-fog-12345.us-east-2.aws.neon.tech/cellweave_dev?sslmode=require with AWS_SECRET_ACCESS_KEY=999fakeKeySecret"
      );

      const res = handleRouteError(fakeSensitiveError);
      expect(res.status).toBe(500);

      const json = await res.json();
      expect(json).toEqual({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      });

      const bodyText = JSON.stringify(json);
      expect(bodyText).not.toContain("super_secret_db_password");
      expect(bodyText).not.toContain("neon.tech");
      expect(bodyText).not.toContain("999fakeKeySecret");
      expect(bodyText).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(bodyText).not.toContain("stack");
    });

    it("maps malformed JSON syntax errors safely to 400 without leaking parser internals", () => {
      const syntaxErr = new SyntaxError("Unexpected token in JSON at position 4");
      const res = handleRouteError(syntaxErr);
      expect(res.status).toBe(400);
    });
  });
});
