/** Public Taric Core entry point. */
export const TARIC_SCHEMA_VERSION = "1.0.0" as const;

export { compileSchema, schemaValidator, validateContract, validationErrors, ContractValidationError } from "./validation.js";
export { uuidv7, DisplayIdAllocator, type SchemaMetadata } from "./identity.js";
export { AuthorityStore, type CanonicalRecord, type Proposal, type TrustLevel, type AdmissionResult, type ReadSnapshot } from "./store.js";
export { buildContextPack, ContextBudgetError, CONTEXT_MINIMUM_BUDGET, PATCH_TO_QUERY_P95_BUDGET_MS, type ContextPack } from "./context.js";
export { createCoverageCell, createNegativeObservation, createControlObservation, createAccessDecisionObservation, validateControlObservation, validateAccessDecisionObservation, evaluateCoverageGate, coverageCloseGate, type CoverageCell, type CoverageCellInput, type CoverageGateResult, type CoverageStatus, type NegativeObservation, type NegativeObservationInput, type ProtectiveControl, type ControlObservation, type AccessDecisionObservation, type ControlOutcome, type DecisionLayer, type AccessDecision, type OriginOutcome } from "./coverage.js";
export { publishProjection, readProjection, pinProjection, unpinProjection, type ProjectionOptions, type ProjectionResult, type ProjectionReadRequest, type ProjectionPermissionResolver } from "./projection.js";
export { ADAPTER_CONTRACT_VERSION, adapterCapabilities, TaricAdapterClient, validateAdapter, createPrincipal, type AdapterCapability, type AdapterCapabilityReport, type AdapterClient, type AdapterContext, type AdapterDescriptor, type AdapterError, type AdapterHostId, type AdapterResult, type PiExtensionApi, type PiHostEvent, type PiLifecycleEventName } from "./adapter.js";
export { createPiAdapter, createPiDescriptor, createPiExtension, isSupportedPiVersion, SUPPORTED_PI_HOST, supportedPiCapabilities } from "./pi-adapter.js";
export { createDeepSeekHarnessAdapter, createDeepSeekDescriptor, createHermesAdapter, createHermesDescriptor } from "./deepseek-adapter.js";
export { TARIC_COMPATIBILITY_MANIFEST, TARIC_DESIGN_INPUTS, TARIC_NON_GOALS, TARIC_SECURITY_INVARIANTS, type CompatibilityManifest, type ManifestCapability, type DesignInput, type NonGoal, type SecurityInvariant } from "./compatibility.js";

export { createCoreService, createCoreServiceForPath, API_CONTRACT_VERSION, type CoreService, type Principal, type PrincipalRole, type ApiEnvelope, type ErrorEnvelope, type ApiResponse, type ApiErrorCode } from "./service.js";
