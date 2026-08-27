# Trend Radar. Every target is a thin wrapper around `node apps/api/src/main.ts`,
# so nothing here is required in order to run the program.

.PHONY: help dev start collect refresh analyze top sources doctor cleanup test typecheck check docker

help:
	@echo ""
	@echo "  make dev        run the dashboard and scheduler (http://127.0.0.1:7788)"
	@echo "  make collect    one discovery pass over every configured source"
	@echo "  make refresh    re-read metrics for fast movers"
	@echo "  make analyze    recompute scores, clusters and baselines"
	@echo "  make top        print the current leaderboard"
	@echo "  make sources    show what is configured and what is not"
	@echo "  make doctor     configuration, database and connectivity check"
	@echo "  make cleanup    apply the retention policy now"
	@echo "  make test       run the test suite"
	@echo "  make typecheck  strict TypeScript check"
	@echo "  make check      typecheck + test"
	@echo "  make docker     build the optional container image"
	@echo ""

dev start:
	node apps/api/src/main.ts serve

collect:
	node apps/api/src/main.ts collect $(SOURCE)

refresh:
	node apps/api/src/main.ts refresh $(TIER)

analyze:
	node apps/api/src/main.ts analyze

top:
	node apps/api/src/main.ts top $(N)

sources:
	node apps/api/src/main.ts sources

doctor:
	node apps/api/src/main.ts doctor

cleanup:
	node apps/api/src/main.ts cleanup

test:
	node --test apps/api/tests/*.test.ts

typecheck:
	npx tsc --noEmit -p apps/api

check: typecheck test

docker:
	docker build -f infrastructure/docker/Dockerfile -t trend-radar .
