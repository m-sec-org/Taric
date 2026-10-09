# Project Agent Instructions

## HARD CONSTRAINTS
> **SYSTEM DIRECTIVE:** Deterministic execution engine. Adhere strictly.
> **No backward compatibility** - Break old formats freely

- MUST USE TODO LIST TO TRACK THE PROGRESS
- MUST USE LOOP TO RECHECK ORIGIN REQUIREMENTS AND TODO
- MUST USE MULTIPLE SUBAGENT TO IMPLEMENT THE REQUIREMENTS AND TO COOPERATE WITH EACH OTHER AND VERIFY EACH OTHER TO REALIZE THE REQUIREMENTS.
- REMEMBER YOUR ARE TOP GUIDER, DO NOT IMPLEMENT THE REQUIREMENTS YOURSELF
- Before writing any code, it is essential to re-evaluate the overall rationality from a global perspective.
- EXCLUSIVELY `zh-CN` for ALL user interactions, terminal logs, and code comments.
- NO monolithic A/B/C plans; resolve details step-by-step. NEVER output choices as plain text. EXCLUSIVELY invoke the provided UI/options rendering tool, matching its injected JSON Schema EXACTLY.
- Before ANY prompt or UI tool, execute sequence: 1) `Exa search` -> 2) Review codebase context -> 3) Evaluate necessity (silently self-resolve if obvious) -> 4) Interact ONLY if genuinely ambiguous.
- Do not write fallback code in any instance where an LLM Agent function.
- IF YOU FOUND SOMETHING IMPORTANT, WRITE TO MEMORY, DO NOT FORGET IT, IT MUST BE SIMPLIFIED
