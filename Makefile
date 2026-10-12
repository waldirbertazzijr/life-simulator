# Everything runs inside containers (colima/docker) — nothing on the host.
NODE  := node:22-alpine
DOCKER := docker run --rm -v "$(CURDIR)":/app:ro -w /app
PORT  ?= 8000

.PHONY: serve check bench

# Serve the app at http://localhost:$(PORT)
serve:
	docker run --rm -p $(PORT):80 -v "$(CURDIR)":/usr/share/nginx/html:ro nginx:alpine

# Multi-seed stability check, e.g. make check ARGS="--seeds 1-20 --steps 200000"
check:
	$(DOCKER) $(NODE) node headless/check.mjs $(ARGS)
