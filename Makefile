# Everything runs inside containers (colima/docker) — nothing on the host.
NODE       := node:22-alpine
PLAYWRIGHT := mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
DOCKER     := docker run --rm -v "$(CURDIR)":/app:ro -w /app
PORT       ?= 8000

.PHONY: serve check shot fingerprint test bot orders bake

# Serve the app at http://localhost:$(PORT)
serve:
	docker run --rm -p $(PORT):80 -v "$(CURDIR)":/usr/share/nginx/html:ro nginx:alpine

# Multi-seed stability check, e.g. make check ARGS="--seeds 1-20 --steps 200000"
check:
	$(DOCKER) $(NODE) node headless/check.mjs $(ARGS)

# A bot plays the controlled person headlessly, in God and Play mode, e.g. make bot ARGS="--seeds 1-20 --steps 20000"
bot:
	$(DOCKER) $(NODE) node headless/bot.mjs $(ARGS)

# Random orders for every tribe, against none, on many seeds, e.g. make orders ARGS="--seeds 73-92 --steps 150000"
orders:
	$(DOCKER) $(NODE) node headless/orders.mjs $(ARGS)

# Behaviour fingerprint (must not change for a pure refactor), e.g. make fingerprint ARGS="--set human.enabled=false"
# Baselines (all:), stage 4 package 1 (the calendar's lives, seasons, night, the doubled world):
# default 2171be5131667e05; --set items.enabled=false d26cc1c85f66306a (the world before items).
# (Stage 3, before the calendar: 2a6f0633606fc95a, items off 5d18bd1739f3aee6.)
fingerprint:
	$(DOCKER) $(NODE) node tools/fingerprint.mjs $(ARGS)

# Unit tests (node:test), e.g. make test ARGS="test/events.test.mjs"
test:
	$(DOCKER) $(NODE) node --test $(or $(ARGS),'test/*.test.mjs')

# Headless-browser screenshots into .shots/, e.g. make shot ARGS="--speed 16 --at 4000,20000"
shot:
	@mkdir -p .shots
	$(DOCKER) -v "$(CURDIR)/.shots":/out --entrypoint node $(PLAYWRIGHT) tools/probe.mjs $(ARGS)

# Flatten a textured, rigged model into our format (Chromium decodes its textures), e.g.
# make bake ARGS="--in assets/local/in/sheep.glb --out assets/local/sheep.glb --budget 1500"
# Inputs and outputs live in the git-ignored assets/local/; a picture of the bake goes to .shots/.
bake:
	@mkdir -p .shots assets/local
	$(DOCKER) -v "$(CURDIR)/.shots":/out -v "$(CURDIR)/assets/local":/app/assets/local --entrypoint node $(PLAYWRIGHT) tools/bake.mjs $(ARGS)
