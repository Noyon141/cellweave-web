/** Internal errors deliberately omit database messages, SQL, credentials, and causes. */
export class DatasetImportFinalizationError extends Error {
  constructor(message = "Dataset import finalization failed") {
    super(message);
    this.name = new.target.name;
  }
}

export class DatasetImportFinalizationConflictError extends DatasetImportFinalizationError {
  constructor() {
    super("Dataset import finalization conflicts with persisted state");
  }
}

export class DatasetImportFinalizationSecurityError extends DatasetImportFinalizationError {
  constructor() {
    super("Dataset import finalization is unavailable in this security context");
  }
}

export class DatasetImportFinalizationConfigurationError extends DatasetImportFinalizationError {
  constructor() {
    super("IMPORT_FINALIZER_DATABASE_URL must configure the dedicated finalizer role");
  }
}

export class DatasetImportFinalizationDatabaseError extends DatasetImportFinalizationError {
  constructor() {
    super("Dataset import finalization database operation failed");
  }
}
