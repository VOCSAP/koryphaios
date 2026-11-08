#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createRoadmapServer } from "./shared/roadmap-server.ts";

await createRoadmapServer({ env: process.env }).connect(new StdioServerTransport());
