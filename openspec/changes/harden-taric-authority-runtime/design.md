# Design

The release evidence generator remains the authority for quality state. A report must identify the source commit, sample digest, annotation provenance, human baseline, strata counts and confidence-interval method. Runtime activation fails closed when any required field is absent, stale or mismatched.

The quality algorithms remain deterministic and consume the pinned sample rather than live mutable records. Evidence is archived with the release candidate and is never inferred from synthetic fixtures.
