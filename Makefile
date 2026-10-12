# Everything runs inside containers (colima/docker) — nothing on the host.
NODE       := node:22-alpine
PLAYWRIGHT := mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
DOCKER     := docker run --rm -v "$(CURDIR)":/app:ro -w /app
PORT       ?= 8000

.PHONY: serve check shot fingerprint

# Serve the app at http://localhost:$(PORT)
serve:
	docker run --rm -p $(PORT):80 -v "$(CURDIR)":/usr/share/nginx/html:ro nginx:alpine

# Multi-seed stability check, e.g. make check ARGS="--seeds 1-20 --steps 200000"
check:
	$(DOCKER) $(NODE) node headless/check.mjs $(ARGS)

# Behaviour fingerprint (must not change for a pure refactor), e.g. make fingerprint ARGS="--set human.enabled=false"
fingerprint:
	$(DOCKER) $(NODE) node tools/fingerprint.mjs $(ARGS)

# Headless-browser screenshots into .shots/, e.g. make shot ARGS="--speed 16 --at 4000,20000"
shot:
	@mkdir -p .shots
	$(DOCKER) -v "$(CURDIR)/.shots":/out --entrypoint node $(PLAYWRIGHT) tools/probe.mjs $(ARGS)
