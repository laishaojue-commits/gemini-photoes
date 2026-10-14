const config = {
  outputDir: process.env.MCP_TEST_OUTPUT_DIR,
  daemonPort: Number(process.env.MCP_TEST_DAEMON_PORT || 1),
  browserDebugPort: 0,
  browserHeadless: true,
  browserProtocolTimeout: 1000,
  daemonTTL: 1000,
};

export default config;
