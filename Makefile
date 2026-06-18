# OpenEmployee — one-command demos.
#
#   make setup      vendor OpenClaw + MakerChecker, install, build
#   make up         start MakerChecker (Postgres + server) via docker compose
#   make demo       the live Governance Control Room
#   make coding     the coding-agent before/after
#   make pa         the finance PA: pays bills with a real Claude agent, capped by a budget
#   make sdr        the SDR: a real Claude agent emails leads; can't be tricked into spamming your company
#   make dlp        the DLP guard: an approved recipient still can't be sent your customer database
#   make tamper     the audit log that fights back (run 'make harden' first)
#   make approval   the human-in-the-loop approval round-trip
#   make attack     a red team tries to break every guarantee
#   make test       run the full test suite
#   make down       stop MakerChecker
#
# The demos read the demo admin/officer API keys straight from the server logs.

.PHONY: setup up down build test demo control-room coding before-after org approval attack pa sdr dlp harden tamper keys

# Lazily pulled from the running server's boot log (admin = 1st key, officer = 2nd).
ADMIN_KEY = $(shell docker compose logs makerchecker 2>/dev/null | grep -o 'mk_[a-f0-9]\{32\}' | sed -n 1p)
OFFICER_KEY = $(shell docker compose logs makerchecker 2>/dev/null | grep -o 'mk_[a-f0-9]\{32\}' | sed -n 2p)
RUN = MAKERCHECKER_API_KEY=$(ADMIN_KEY) node examples

setup:
	./setup.sh && corepack pnpm install && corepack pnpm -r build

up:
	docker compose up -d --build
	@echo "MakerChecker is on http://localhost:3000"

down:
	docker compose down

build:
	corepack pnpm -r --filter "./packages/**" build

test:
	corepack pnpm -r --filter "./packages/**" test

keys:
	@echo "admin:   $(ADMIN_KEY)"
	@echo "officer: $(OFFICER_KEY)"

control-room demo:
	@$(RUN)/control-room.mjs

coding:
	@$(RUN)/coding-agent.mjs

attack:
	@$(RUN)/red-team.mjs

pa:
	@MAKERCHECKER_API_KEY=$(ADMIN_KEY) node --env-file-if-exists=.env examples/finance-pa.mjs

sdr:
	@MAKERCHECKER_API_KEY=$(ADMIN_KEY) node --env-file-if-exists=.env examples/outreach-agent.mjs

dlp:
	@MAKERCHECKER_API_KEY=$(ADMIN_KEY) node --env-file-if-exists=.env examples/dlp.mjs

# Provision the non-owner mc_app_runtime role on the running DB (the two-role
# tamper-resistance setup). Run once before `make tamper`.
harden:
	@cat vendor/makerchecker/ops/harden-db.sql | docker compose exec -T postgres psql -q -U makerchecker -d makerchecker -v mc_runtime_password=oe_runtime >/dev/null \
	  && echo "hardened: mc_app_runtime role provisioned" \
	  || echo "harden failed — is 'make up' running and vendor/makerchecker present (make setup)?"

tamper:
	@MAKERCHECKER_API_KEY=$(ADMIN_KEY) \
	  MC_RUNTIME_DATABASE_URL=postgres://mc_app_runtime:oe_runtime@localhost:5432/makerchecker \
	  node --env-file-if-exists=.env examples/tamper-evident.mjs

before-after:
	@$(RUN)/ungoverned-vs-governed.mjs

org:
	@$(RUN)/org-demo.mjs

apply:
	@$(RUN)/onboard-org.mjs

approval:
	@MAKERCHECKER_API_KEY=$(ADMIN_KEY) MAKERCHECKER_OFFICER_KEY=$(OFFICER_KEY) node examples/approval.mjs
