.PHONY: check typecheck test agent-check manifest-check plugin-check

check: typecheck test agent-check manifest-check plugin-check

typecheck:
	tsc --project tsconfig.json

test:
	tsc --project tsconfig.test.json
	tsc --project tsconfig.plugin-test.json
	node --test --test-concurrency=1 tests/*.test.cjs

agent-check:
	node --check bin/copilot-agent.mjs

manifest-check:
	python3 scripts/validate_manifest.py

plugin-check:
	fresh --check-plugin fresh-copilot.ts
