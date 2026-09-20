#!/usr/bin/env node
// Local (stdio) entry point: what `npx pakistan-mutual-funds-mcp` runs.
// The server itself lives in server.js, shared with the hosted connector.
//
// Zero-setup by default: reads the free public dataset. Point API_BASE_URL at
// a self-hosted pakistan-mutual-funds-api instance to use live endpoints
// instead, or DATASET_BASE_URL at a mirror/fork of the dataset.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

const server = createServer({ apiBase: process.env.API_BASE_URL, datasetBase: process.env.DATASET_BASE_URL })
await server.connect(new StdioServerTransport())
