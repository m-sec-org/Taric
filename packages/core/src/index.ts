/** Public Taric Core entry point. */
export const TARIC_SCHEMA_VERSION = "1.0.0" as const;

export { compileSchema, schemaValidator } from "./validation.js";
export { uuidv7, DisplayIdAllocator, type SchemaMetadata } from "./identity.js";
export { AuthorityStore, type CanonicalRecord, type Proposal, type TrustLevel, type AdmissionResult, type ReadSnapshot } from "./store.js";
export { buildContextPack, type ContextPack } from "./context.js";
export { createCoverageCell, createNegativeObservation, type CoverageCell, type CoverageStatus, type NegativeObservation } from "./coverage.js";
export { publishProjection, readProjection, type ProjectionOptions, type ProjectionResult } from "./projection.js";
export { ADAPTER_CONTRACT_VERSION, adapterCapabilities, TaricAdapterFacade, validateAdapter, type AdapterCapability, type AdapterContext, type AdapterDescriptor, type AdapterResult } from "./adapter.js";
export { createPiAdapter } from "./pi-adapter.js";
export { createDeepSeekHarnessAdapter } from "./deepseek-adapter.js";
