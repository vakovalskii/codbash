.SILENT:

SHELL = /bin/bash

PORT = 3847
NODE = node
LOG_FILE = /tmp/codedash.log
PID_FILE = /tmp/codedash.pid

.PHONY: help run stop status restart test

help:
	@echo "CodeDash - Dashboard for AI coding agents"
	@echo ""
	@echo "Available commands:"
	@echo "  make run      - Start CodeDash"
	@echo "  make stop     - Stop CodeDash"
	@echo "  make status   - Check if CodeDash is running"
	@echo "  make restart  - Restart CodeDash"
	@echo "  make log      - View logs"
	@echo "  make test     - Test server is responding"

run:
	@if curl -m 2 -s http://localhost:$(PORT)/api/version > /dev/null 2>&1; then \
		echo "CodeDash is already running at http://localhost:$(PORT)"; \
	else \
		echo "Starting CodeDash..."; \
		setsid $(NODE) bin/cli.js run > $(LOG_FILE) 2>&1 & \
		sleep 2; \
		if curl -m 2 -s http://localhost:$(PORT)/api/version > /dev/null 2>&1; then \
			echo "✓ CodeDash started at http://localhost:$(PORT)"; \
		else \
			echo "✗ Failed to start (check $(LOG_FILE))"; \
		fi; \
	fi

stop:
	@pkill -f "node bin/cli.js run" 2>/dev/null || true
	@sleep 1
	@if curl -m 1 -s http://localhost:$(PORT)/api/version > /dev/null 2>&1; then \
		pkill -9 -f "cli.js" 2>/dev/null || true; \
		echo "✓ CodeDash stopped"; \
	else \
		echo "✓ CodeDash stopped"; \
	fi

status:
	@if curl -m 2 -s http://localhost:$(PORT)/api/version > /dev/null 2>&1; then \
		echo "✓ CodeDash is running at http://localhost:$(PORT)"; \
		curl -m 1 -s http://localhost:$(PORT)/api/version 2>/dev/null | grep -o '"current":"[^"]*"' | head -1; \
	else \
		echo "✗ CodeDash is not running"; \
	fi

restart: stop run

log:
	@tail -f $(LOG_FILE)

test:
	@curl -m 2 -s http://localhost:$(PORT)/api/version 2>/dev/null || echo "Server not responding"

